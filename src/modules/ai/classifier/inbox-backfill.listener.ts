import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { PrismaService } from '@/database/prisma.service';
import { BACKFILL_INBOX_JOB, BACKFILL_QUEUE } from './classifier.constants';
import { BackfillInboxJobData } from './classifier.types';

/**
 * Queues a one-off pass over the mail a mailbox already held, the moment its
 * Gmail watch is live.
 *
 * WHY the backfill exists: a watch only reports what happens NEXT. Without
 * this, a company that signs up on Tuesday has no analysis of anything that
 * arrived on Monday — not "later", but never — and the first thing they see
 * after paying is an empty dashboard.
 *
 * WHY it waits for `gmail.watch.established` rather than answering
 * `google.account.connected` alongside GmailWebhookService: those two handlers
 * have no ordering between them, and listing the backlog first opens a window
 * where a message is in neither set — too new for the snapshot, too old for a
 * history feed that has not been anchored yet. Lost, permanently. Chaining off
 * the watch closes the window and, as a bonus, means a failed watch queues no
 * backfill at all (it could not authenticate anyway).
 *
 * Separate listener rather than a second call inside the webhook service: the
 * watch is an email-module concern and the classifier queue is an AI-module
 * one, and wiring them together would have the email module importing the AI
 * module purely to enqueue.
 */
@Injectable()
export class InboxBackfillListener {
  private readonly logger = new Logger(InboxBackfillListener.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(BACKFILL_QUEUE) private readonly queue: Queue,
  ) {}

  @OnEvent('gmail.watch.established')
  async handleWatchEstablished(payload: {
    id: string;
    email: string;
  }): Promise<void> {
    const account = await this.prisma.connectedAccount.findUnique({
      where: { id: payload.id },
      select: { isAdmin: true, tenantId: true },
    });

    // Both skips also hold upstream — a watch is never opened for an admin
    // account or one without a tenant — but they are re-checked here rather
    // than assumed, because this listener is bound to an event name, not to
    // one caller, and an admin mailbox is the one place a backfill would read
    // mail that is not a Sales Engineer's to analyse.
    if (account?.isAdmin) return;
    if (!account?.tenantId) {
      this.logger.warn(
        `Skipping inbox backfill for ${payload.email}: account has no tenant yet.`,
      );
      return;
    }

    await this.enqueue(payload.email);
  }

  /**
   * Deterministic jobId keyed on the address: connecting twice, or an event
   * delivered twice, collapses onto one backfill instead of classifying the
   * same 500 messages again. `classifyOne` would no-op on the repeats anyway,
   * but only after paying for a Gmail fetch each.
   */
  async enqueue(emailAddress: string): Promise<void> {
    const data: BackfillInboxJobData = { emailAddress };
    await this.queue.add(BACKFILL_INBOX_JOB, data, {
      jobId: `backfill#${emailAddress}`,
      // The pass stops itself on a provider rate limit, which is a "come back
      // later", not a failure of the work — so it has to be retried or the
      // remainder is simply dropped. Everything already stored is skipped on
      // the way back through, so a retry costs the leftovers, not the walk.
      // Spacing starts at a minute because a 429 outlives a 5s backoff.
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 20,
      removeOnFail: 50,
    });
    this.logger.log(`Inbox backfill queued for ${emailAddress}`);
  }
}
