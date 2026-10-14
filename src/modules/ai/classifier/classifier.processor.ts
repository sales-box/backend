import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { GmailProvider } from '../../email/gmail/gmail-provider.service';
import {
  isHistoryExpiredError,
  isRateLimitError,
} from './classifier-errors.util';
import { CLASSIFIER_QUEUE, CLASSIFY_EMAIL_JOB } from './classifier.constants';
import { ClassifyEmailJobData, ClassifyJobResult } from './classifier.types';
import { MessageClassifier } from './message-classifier.service';

/**
 * Background half of the AI pipeline (design doc §0): consumes webhook jobs,
 * diffs Gmail history, and classifies each new inbox message exactly once.
 * Failure contract: throwing lets BullMQ retry the whole job; the unique
 * messageId makes retries cheap (already-stored messages are skipped), and
 * the baseline only advances after a fully clean pass.
 */
// Limiter: hard ceiling on job pickup so a burst of notifications can never
// outrun the LLM provider's quota (free-tier RPM is small). Per-message calls
// inside one job are bounded separately by the stop-on-429 rule below.
@Processor(CLASSIFIER_QUEUE, { limiter: { max: 5, duration: 60_000 } })
export class ClassifierProcessor extends WorkerHost {
  private readonly logger = new Logger(ClassifierProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gmailProvider: GmailProvider,
    private readonly messages: MessageClassifier,
  ) {
    super();
  }

  async process(job: Job<ClassifyEmailJobData>): Promise<ClassifyJobResult> {
    // Named explicitly rather than "anything that is not X". A job whose name
    // we do not recognise is a producer bug, and treating it as a live
    // notification would read `data.historyId` off a payload that has none and
    // silently re-anchor the baseline from `undefined`.
    if (job.name !== CLASSIFY_EMAIL_JOB) {
      throw new Error(
        `Unknown job "${job.name}" on the ${CLASSIFIER_QUEUE} queue`,
      );
    }
    return this.processLiveNotification(job.data);
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
          await this.messages.classifyOne(messageId, {
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
}
