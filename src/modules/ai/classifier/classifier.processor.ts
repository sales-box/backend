import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { ParsedMessage } from '../../email/email.types';
import { GmailProvider } from '../../email/gmail/gmail-provider.service';
import {
  CLASSIFIER_PROMPT_VERSION,
  CLASSIFIER_QUEUE,
} from './classifier.constants';
import { ClassifierService } from './classifier.service';
import { ClassifyEmailJobData, ClassifyJobResult } from './classifier.types';
import { prepareEmailText } from './email-text.util';

function httpStatusOf(error: unknown): number | undefined {
  return (
    (error as { code?: number }).code ??
    (error as { response?: { status?: number } }).response?.status
  );
}

/** Gmail signals an expired/unknown startHistoryId with a 404. */
function isHistoryExpiredError(error: unknown): boolean {
  return httpStatusOf(error) === 404;
}

/**
 * A single message that can no longer be fetched (deleted/expunged after it was
 * added to INBOX) returns 404/410. This is PERMANENT: it must be skipped, never
 * counted as a batch failure — otherwise it would freeze the history baseline
 * and wedge all future classification for the account.
 */
function isMessageGoneError(error: unknown): boolean {
  const status = httpStatusOf(error);
  return status === 404 || status === 410;
}

/**
 * Provider rate-limit (429). LlmClientService re-wraps API errors into a plain
 * Error ("LLM Generation Error: 429 status code ..."), so the HTTP status only
 * survives in the message text — hence the regex fallback.
 */
function isRateLimitError(error: unknown): boolean {
  if (httpStatusOf(error) === 429) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b/.test(message);
}

/**
 * Background half of the AI pipeline (design doc §0): consumes webhook jobs,
 * diffs Gmail history, and classifies each new inbox message exactly once.
 * Failure contract: throwing lets BullMQ retry the whole job; the unique
 * messageId makes retries cheap (already-stored messages are skipped), and
 * the baseline only advances after a fully clean pass.
 */
// Limiter: hard ceiling on job pickup so a burst of notifications can never
// outrun the LLM provider's quota (free-tier RPM is small). Per-message calls
// inside one job are bounded separately by the stop-on-429 rule in process().
@Processor(CLASSIFIER_QUEUE, { limiter: { max: 10, duration: 60_000 } })
export class ClassifierProcessor extends WorkerHost {
  private readonly logger = new Logger(ClassifierProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gmailProvider: GmailProvider,
    private readonly classifier: ClassifierService,
  ) {
    super();
  }

  async process(job: Job<ClassifyEmailJobData>): Promise<ClassifyJobResult> {
    const { emailAddress, historyId } = job.data;

    const account = await this.prisma.connectedAccount.findFirst({
      where: { email: emailAddress, status: 'connected' },
    });
    if (!account) {
      this.logger.warn(
        'Notification for an unknown/disconnected account; skipping',
      );
      return { skipped: 'no_account', classified: 0 };
    }

    const subscription = await this.prisma.webhookSubscription.findUnique({
      where: { connectedAccountId: account.id },
    });
    if (!subscription?.lastHistoryId) {
      // First notification we can anchor on: seed the baseline, classify from
      // the next notification onward.
      if (subscription) {
        await this.prisma.webhookSubscription.update({
          where: { connectedAccountId: account.id },
          data: { lastHistoryId: historyId },
        });
      }
      return { skipped: 'no_baseline', classified: 0 };
    }

    let messageIds: string[];
    let newHistoryId: string;
    try {
      ({ messageIds, newHistoryId } =
        await this.gmailProvider.fetchNewMessageIds(
          emailAddress,
          subscription.lastHistoryId,
        ));
    } catch (error) {
      if (isHistoryExpiredError(error)) {
        // Gmail keeps ~1 week of history; re-anchor and move on.
        await this.prisma.webhookSubscription.update({
          where: { connectedAccountId: account.id },
          data: { lastHistoryId: historyId },
        });
        return { skipped: 'history_expired', classified: 0 };
      }
      throw error; // auth/network → BullMQ retry
    }

    let classified = 0;
    let failed = 0;
    for (const messageId of messageIds) {
      try {
        if (await this.classifyOne(messageId, account)) classified += 1;
      } catch (error) {
        // Quota exhausted: every further call this minute would 429 too, so
        // stop NOW instead of burning one failed call per remaining message.
        // Rows stored before this point survive (messageId-unique dedup), the
        // baseline stays frozen, and the BullMQ backoff retry resumes exactly
        // where we stopped once the provider window reopens.
        if (isRateLimitError(error)) {
          this.logger.warn(
            `LLM provider rate-limited after ${classified} classified; deferring the rest of the batch to a retry`,
          );
          throw new Error(
            'Classifier hit the LLM provider rate limit; batch deferred',
          );
        }
        failed += 1;
        this.logger.error(
          `Classification failed for a message: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (failed > 0) {
      throw new Error(
        `Classifier failed for ${failed}/${messageIds.length} messages`,
      );
    }

    await this.prisma.webhookSubscription.update({
      where: { connectedAccountId: account.id },
      data: { lastHistoryId: newHistoryId },
    });
    return { classified };
  }

  private async classifyOne(
    messageId: string,
    account: { id: string; email: string; tenantId: string | null },
  ): Promise<boolean> {
    // Exactly-once rule (design doc §1): the stored row is the cache.
    const existing = await this.prisma.generalAnalysis.findUnique({
      where: { messageId },
    });
    if (existing) return false;

    let parsed: ParsedMessage;
    try {
      parsed = await this.gmailProvider.fetchMessage(messageId, account.email);
    } catch (error) {
      // Message gone (deleted after the history record) is permanent — skip it,
      // don't let it fail the batch and freeze the baseline. Anything else
      // (auth/network) is transient and propagates to a BullMQ retry.
      if (isMessageGoneError(error)) {
        this.logger.warn('Message no longer retrievable (gone); skipping');
        return false;
      }
      throw error;
    }

    // The subject carries strong intent/urgency signal ("URGENT: ...",
    // "cancelling our contract") and is sometimes the ONLY content, so it is
    // classified alongside the body (both caged as untrusted by classify()).
    const body = prepareEmailText(parsed.textPlain, parsed.textHtml);
    const subject = (parsed.subject ?? '').trim();
    const text = subject ? `Subject: ${subject}\n\n${body}`.trim() : body;
    if (text.length === 0) {
      this.logger.warn('Message has no classifiable text; skipping');
      return false;
    }

    const result = await this.classifier.classify(text);

    try {
      await this.prisma.generalAnalysis.create({
        data: {
          messageId,
          threadId: parsed.threadId || null,
          accountEmail: account.email,
          tenantId: account.tenantId,
          isUrgent: result.isUrgent,
          urgencyReason: result.urgencyReason,
          intent: result.intent,
          intentConfidence: result.intentConfidence,
          reasoning: result.reasoning,
          promptVersion: CLASSIFIER_PROMPT_VERSION,
        },
      });
    } catch (error) {
      // P2002: a concurrent worker stored it first — the result exists, done.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }
    return true;
  }
}
