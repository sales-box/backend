import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { GmailProvider } from '../../email/gmail/gmail-provider.service';
import { isRateLimitError } from './classifier-errors.util';
import {
  BACKFILL_INBOX_JOB,
  BACKFILL_MAX_MESSAGES,
  BACKFILL_NEWER_THAN_DAYS,
  BACKFILL_QUEUE,
} from './classifier.constants';
import { BackfillInboxJobData, ClassifyJobResult } from './classifier.types';
import { MessageClassifier } from './message-classifier.service';

/**
 * One pass over the mail a mailbox already held when it was connected.
 *
 * Unlike the live path this touches NO history baseline. The two run against
 * the same mailbox at the same time — a backfill triggered on connect races
 * the first real notification — and moving `lastHistoryId` from here could
 * drag the live cursor backwards or forwards over messages the other side
 * had not finished with. Overlap is safe instead because both go through
 * `MessageClassifier.classifyOne`, whose stored-row check is the exactly-once
 * guard.
 */
// Own queue, own worker: a single job here is a serial walk of up to
// BACKFILL_MAX_MESSAGES fetch+classify round trips, and on the live queue that
// walk sat in front of every incoming notification. concurrency 1 keeps two
// connections from doubling the LLM spend rate, and the limiter keeps the
// catch-up deliberately slower than the live path it must never crowd out.
@Processor(BACKFILL_QUEUE, {
  concurrency: 1,
  limiter: { max: 2, duration: 60_000 },
})
export class InboxBackfillProcessor extends WorkerHost {
  private readonly logger = new Logger(InboxBackfillProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gmailProvider: GmailProvider,
    private readonly messages: MessageClassifier,
  ) {
    super();
  }

  async process(job: Job<BackfillInboxJobData>): Promise<ClassifyJobResult> {
    if (job.name !== BACKFILL_INBOX_JOB) {
      throw new Error(
        `Unknown job "${job.name}" on the ${BACKFILL_QUEUE} queue`,
      );
    }
    return this.processBacklog(job.data);
  }

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
          await this.messages.classifyOne(messageId, {
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
          // THROW, do not return. Reporting the partial pass as a completed job
          // is how the remainder used to be abandoned silently: BullMQ has no
          // other signal that there is work left, so the messages after this
          // point stayed unclassified until someone reconnected the mailbox.
          // Failing hands the rest to the backoff retry, which skips everything
          // already stored and resumes from here.
          this.logger.warn(
            `Backfill for ${emailAddress} hit a rate limit after ${classified} ` +
              'message(s); deferring the remainder to a retry.',
          );
          throw new Error(
            `Inbox backfill for ${emailAddress} hit the LLM provider rate limit; remainder deferred`,
          );
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
}
