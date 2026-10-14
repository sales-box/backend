import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailNotifyService } from '../email-notify/email-notify.service';
import {
  SEND_SE_REVOKED_JOB,
  SE_INVITE_QUEUE,
  SeMailJobData,
} from './allowlist.constants';

/**
 * Delivers SE invite emails off the request thread.
 *
 * Why a queue: a bulk grant of 50 addresses used to mean 50 sequential SMTP
 * round-trips inside one HTTP request. It also meant a transient SMTP failure
 * lost that invite permanently — EmailNotifyService.sendSeInvite catches and
 * logs, so nothing ever retried and the SE simply never heard from us.
 *
 * This processor asks the mailer to THROW on failure (raise = true) so BullMQ's
 * retry/backoff can do its job. The grant itself is already committed by the
 * time a job runs, so a failed send never rolls back access.
 */
@Processor(SE_INVITE_QUEUE)
export class SeInviteProcessor extends WorkerHost {
  private readonly logger = new Logger(SeInviteProcessor.name);

  constructor(private readonly email: EmailNotifyService) {
    super();
  }

  async process(job: Job<SeMailJobData>): Promise<void> {
    const { email, companyName } = job.data;

    // One queue, two templates — the job name picks which. Keeping them on the
    // same queue means the retry/backoff policy and the worker concurrency are
    // defined once, and a revocation notice cannot be starved by a burst of
    // invites (or the reverse).
    if (job.name === SEND_SE_REVOKED_JOB) {
      await this.email.sendSeRevoked(email, companyName, true);
      this.logger.log(`SE revocation notice delivered to ${email}`);
      return;
    }

    await this.email.sendSeInvite(email, companyName, true);
    this.logger.log(`SE invite delivered to ${email}`);
  }
}
