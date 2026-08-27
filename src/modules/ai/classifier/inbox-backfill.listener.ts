import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { PrismaService } from '@/database/prisma.service';
import { BACKFILL_INBOX_JOB, CLASSIFIER_QUEUE } from './classifier.constants';
import { BackfillInboxJobData } from './classifier.types';

/**
 * Queues a one-off pass over the mail a mailbox already held, the moment it is
 * connected.
 *
 * WHY: `GmailWebhookService` answers the same event by opening a Gmail watch,
 * and a watch only reports what happens NEXT. Without this, a company that
 * signs up on Tuesday has no analysis of anything that arrived on Monday — not
 * "later", but never — and the first thing they see after paying is an empty
 * dashboard. Connecting a mailbox should mean the product knows what is in it.
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
    @InjectQueue(CLASSIFIER_QUEUE) private readonly queue: Queue,
  ) {}

  @OnEvent('google.account.connected')
  async handleGoogleAccountConnected(payload: {
    id: string;
    email: string;
  }): Promise<void> {
    const account = await this.prisma.connectedAccount.findUnique({
      where: { id: payload.id },
      select: { isAdmin: true, tenantId: true },
    });

    // Both skips mirror GmailWebhookService exactly. An admin account is not a
    // Sales Engineer mailbox, and an account with no tenant yet cannot resolve
    // the credentials a Gmail client is built from — the admin-first-connect
    // flow links the tenant on a later pass, which re-fires this event.
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
      // One attempt only. A backfill is best-effort catch-up, and it is already
      // internally resilient — per-message failures are logged and stepped
      // over. Retrying the whole pass would re-walk everything it did finish.
      attempts: 1,
      removeOnComplete: 20,
      removeOnFail: 50,
    });
    this.logger.log(`Inbox backfill queued for ${emailAddress}`);
  }
}
