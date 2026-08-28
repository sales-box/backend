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
   * Deterministic jobId keyed on the address: two connect events arriving
   * together collapse onto one backfill instead of walking the same 500
   * messages twice. `classifyOne` would no-op on the repeats anyway, but only
   * after paying for a Gmail fetch each.
   *
   * THE CATCH, and why the remove() below exists: BullMQ enforces that id
   * against FINISHED jobs too, and both `removeOnComplete` and `removeOnFail`
   * retain a window of them. So one completed — or worse, one exhausted-retry
   * failed — backfill made the address permanently un-enqueueable. Signing out
   * and back in, the only trigger a user has, then did nothing at all and said
   * nothing about it. A feature that cannot be re-run after it fails is a
   * feature that is broken once and broken forever.
   *
   * Dropping any finished job with this id first restores that. It cannot
   * disturb a run in progress: BullMQ refuses to remove an ACTIVE job, the
   * error is swallowed, and the add that follows is the no-op it should be —
   * which is exactly the duplicate-collapsing this id was chosen for.
   */
  async enqueue(emailAddress: string): Promise<void> {
    const jobId = `backfill#${emailAddress}`;

    try {
      await this.queue.remove(jobId);
    } catch {
      // Active job, or nothing there. Either way the add below does the right
      // thing, so there is nothing to report.
    }

    const data: BackfillInboxJobData = { emailAddress };
    await this.queue.add(BACKFILL_INBOX_JOB, data, {
      jobId,
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
