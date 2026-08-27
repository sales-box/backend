import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { ParsedMessage } from '../../email/email.types';
import { GmailProvider } from '../../email/gmail/gmail-provider.service';
import {
  BACKFILL_INBOX_JOB,
  BACKFILL_MAX_MESSAGES,
  BACKFILL_NEWER_THAN_DAYS,
  CLASSIFIER_PROMPT_VERSION,
  CLASSIFIER_QUEUE,
} from './classifier.constants';
import { ClassifierService } from './classifier.service';
import {
  BackfillInboxJobData,
  ClassifyEmailJobData,
  ClassifyJobResult,
} from './classifier.types';
import { prepareEmailText } from './email-text.util';
import { ClientsService } from '../../clients/clients.service';

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
@Processor(CLASSIFIER_QUEUE, { limiter: { max: 5, duration: 60_000 } })
export class ClassifierProcessor extends WorkerHost {
  private readonly logger = new Logger(ClassifierProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gmailProvider: GmailProvider,
    private readonly classifier: ClassifierService,
    private readonly clientsService: ClientsService,
  ) {
    super();
  }

  /**
   * Two job shapes share this worker, and deliberately so: both end in
   * `classifyOne`, whose stored-row check is what makes the live path and the
   * backlog pass safe to overlap. Splitting them into separate processors would
   * have put that guarantee behind a second queue's concurrency settings.
   */
  async process(
    job: Job<ClassifyEmailJobData | BackfillInboxJobData>,
  ): Promise<ClassifyJobResult> {
    if (job.name === BACKFILL_INBOX_JOB) {
      return this.processBacklog(job.data);
    }
    return this.processLiveNotification(job.data as ClassifyEmailJobData);
  }

  /**
   * One pass over the mail a mailbox already held when it was connected.
   *
   * Unlike the live path this touches NO history baseline. The two run against
   * the same mailbox at the same time — a backfill triggered on connect races
   * the first real notification — and moving `lastHistoryId` from here could
   * drag the live cursor backwards or forwards over messages the other side
   * had not finished with.
   */
  private async processBacklog(
    data: BackfillInboxJobData,
  ): Promise<ClassifyJobResult> {
    const { emailAddress } = data;

    const account = await this.prisma.connectedAccount.findFirst({
      where: { email: emailAddress, status: 'connected' },
    });
    if (!account) return { skipped: 'no_account', classified: 0 };
    if (!account.tenantId) return { skipped: 'no_tenant', classified: 0 };

    const messageIds = await this.gmailProvider.listLabelledMessageIds(
      account.tenantId,
      account.email,
      {
        maxMessages: BACKFILL_MAX_MESSAGES,
        newerThanDays: BACKFILL_NEWER_THAN_DAYS,
      },
    );

    this.logger.log(
      `Backfill for ${emailAddress}: ${messageIds.length} message(s) in the last ` +
        `${BACKFILL_NEWER_THAN_DAYS} days (cap ${BACKFILL_MAX_MESSAGES})`,
    );

    let classified = 0;
    let failed = 0;
    for (const messageId of messageIds) {
      try {
        if (
          await this.classifyOne(messageId, {
            id: account.id,
            email: account.email,
            tenantId: account.tenantId,
          })
        ) {
          classified++;
        }
      } catch (error) {
        // A backfill is unattended and best-effort: one unreadable message must
        // not cost the customer the other 499. Rate limiting is the exception —
        // continuing past a 429 just burns the rest of the quota against a wall.
        if (isRateLimitError(error)) {
          this.logger.warn(
            `Backfill for ${emailAddress} stopped early on a rate limit after ` +
              `${classified} message(s); the remainder stays unclassified until ` +
              `it is re-run.`,
          );
          break;
        }
        failed++;
        this.logger.error(
          `Backfill failed on ${messageId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (failed > 0) {
      this.logger.warn(
        `Backfill for ${emailAddress}: ${failed}/${messageIds.length} message(s) failed`,
      );
    }
    this.logger.log(
      `Backfill for ${emailAddress} complete: ${classified} newly classified`,
    );
    return { classified };
  }

  private async processLiveNotification(
    data: ClassifyEmailJobData,
  ): Promise<ClassifyJobResult> {
    const { emailAddress, historyId } = data;

    const account = await this.prisma.connectedAccount.findFirst({
      where: { email: emailAddress, status: 'connected' },
    });
    if (!account) {
      this.logger.warn(
        'Notification for an unknown/disconnected account; skipping',
      );
      return { skipped: 'no_account', classified: 0 };
    }
    // Gmail credentials are resolved by a tenant-scoped lookup, so an account
    // not yet linked to a tenant cannot be polled at all.
    if (!account.tenantId) {
      this.logger.warn(
        `Notification for an account with no tenant (${account.email}); skipping`,
      );
      return { skipped: 'no_tenant', classified: 0 };
    }
    const tenantId = account.tenantId;

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
          tenantId,
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
        if (
          await this.classifyOne(messageId, {
            id: account.id,
            email: account.email,
            tenantId,
          })
        )
          classified += 1;
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

    let sentNewHistoryId = newHistoryId;
    try {
      const sentResult = await this.gmailProvider.fetchNewSentThreadIds(
        tenantId,
        emailAddress,
        subscription.lastHistoryId,
      );
      sentNewHistoryId = sentResult.newHistoryId;
      if (sentResult.threadIds.length > 0) {
        await this.prisma.generalAnalysis.updateMany({
          where: {
            threadId: { in: sentResult.threadIds },
            accountEmail: account.email,
            tenantId: account.tenantId,
            reviewedAt: null,
          },
          data: { reviewedAt: new Date() },
        });
      }
    } catch (error) {
      if (!isHistoryExpiredError(error)) throw error;
      // history_expired here just means nothing to re-anchor for SENT this
      // round — the INBOX baseline handling below still applies.
    }

    // Baseline must advance past whichever diff saw further into history.
    // historyId is a numeric string; compare numerically, not lexically.
    const finalHistoryId =
      BigInt(sentNewHistoryId) > BigInt(newHistoryId)
        ? sentNewHistoryId
        : newHistoryId;

    await this.prisma.webhookSubscription.update({
      where: { connectedAccountId: account.id },
      data: { lastHistoryId: finalHistoryId },
    });
    return { classified };
  }

  private async classifyOne(
    messageId: string,
    // `tenantId` is non-null here: `process()` returns early for an account
    // without one, because credentials cannot be resolved without a tenant.
    account: { id: string; email: string; tenantId: string },
  ): Promise<boolean> {
    // Exactly-once rule (design doc §1): the stored row is the cache.
    const existing = await this.prisma.generalAnalysis.findUnique({
      where: { messageId },
    });
    if (existing) return false;

    let parsed: ParsedMessage;
    try {
      parsed = await this.gmailProvider.fetchMessage(
        account.tenantId,
        messageId,
        account.email,
      );
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

    // Verify message has the 'salesbox' label
    const salesboxLabelIds = await this.gmailProvider.getSalesboxLabelIds(
      account.tenantId,
      account.email,
    );
    if (salesboxLabelIds.length > 0) {
      const messageLabelIds = parsed.labelIds ?? [];
      const hasSalesboxLabel = salesboxLabelIds.some((id) =>
        messageLabelIds.includes(id),
      );
      if (!hasSalesboxLabel) {
        this.logger.debug(
          `Message ${messageId} does not have the 'salesbox' label; skipping classification`,
        );
        return false;
      }
    } else {
      this.logger.warn(
        `Account ${account.email} does not have a 'salesbox' label created in Gmail; skipping classification`,
      );
      return false;
    }

    // Skip the SE's own outbound messages (replies we sent). Gmail threads them
    // into the conversation, but classifying them inflates the processed count
    // and mislabels our own reply as an inbound "follow-up".
    const fromRaw = parsed.from ?? '';
    const fromEmail = (fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw)
      .trim()
      .toLowerCase();
    if (fromEmail && fromEmail === account.email.trim().toLowerCase()) {
      this.logger.debug(
        'SE-authored (outbound) message; skipping classification',
      );
      return false;
    }

    const hasValidSender = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail);
    if (!hasValidSender) {
      this.logger.warn('Message has no valid sender email; skipping capture');
    }
    if (!account.tenantId) {
      this.logger.warn('Connected account has no tenant; skipping capture');
    }

    // Capture before any AI work so an empty body, provider outage, or worker
    // retry can never lose the first inbound touchpoint.
    if (account.tenantId && hasValidSender) {
      await this.clientsService.captureInboundEmail(account.tenantId, {
        messageId,
        senderEmail: fromEmail,
        senderName: this.extractSenderName(fromRaw),
        date: parsed.date,
        subject: parsed.subject,
      });
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

    if (account.tenantId && hasValidSender) {
      await this.clientsService.captureInboundEmail(account.tenantId, {
        messageId,
        senderEmail: fromEmail,
        senderName: this.extractSenderName(fromRaw),
        date: parsed.date,
        subject: parsed.subject,
        aiSummary: result.reasoning,
        classification: result.intent,
      });
    }

    try {
      const created = await this.prisma.generalAnalysis.create({
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
          isComplaint: result.isComplaint,
          complaintAbout: result.complaintAbout,
        },
      });

      // A complaint about the sales engineer, or about how the company treated
      // the client, has to reach the admin on its own account. Routed only to
      // the SE's inbox, the person being complained about is the one who
      // decides whether anyone else ever hears about it — which is exactly the
      // oversight this product is supposed to provide.
      const isOversightComplaint =
        result.isComplaint &&
        (result.complaintAbout === 'person' ||
          result.complaintAbout === 'service');

      if (
        created?.id &&
        account.tenantId &&
        (result.isUrgent ||
          result.intent === 'sensitive' ||
          isOversightComplaint)
      ) {
        // A complaint naming the individual outranks everything: it is the one
        // case where the usual routing has a conflict of interest built in.
        const severity =
          result.complaintAbout === 'person'
            ? 'high'
            : result.isUrgent && result.intent === 'sensitive'
              ? 'high'
              : 'medium';
        // The classification itself is already stored and must not be rolled
        // back by a failed escalation write — but the failure has to be
        // audible. This used to be `.catch(() => {})`, which is how the whole
        // feature ran for weeks against a database that had no
        // escalation_items table at all, reporting success every time.
        try {
          await this.prisma.escalationItem.upsert({
            where: { generalAnalysisId: created.id },
            create: {
              tenantId: account.tenantId,
              generalAnalysisId: created.id,
              messageId,
              accountEmail: account.email,
              severity,
              reason: result.urgencyReason || result.reasoning,
            },
            update: {},
          });
        } catch (escalationError) {
          this.logger.error(
            `Escalation write FAILED for message ${messageId} (tenant ${account.tenantId}, severity ${severity}): ` +
              `${escalationError instanceof Error ? escalationError.message : String(escalationError)}. ` +
              'The classification was stored; the admin escalation feed will not show this email.',
          );
        }
      }
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

  private extractSenderName(from: string): string | undefined {
    const name = from
      .match(/^\s*(.*?)\s*<[^>]+>/)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '');
    return name || undefined;
  }
}
