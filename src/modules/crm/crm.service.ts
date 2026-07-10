import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ClientRecord } from '../clients/clients.interface';
import {
  CRM_QUEUE,
  SYNC_CONTACT_JOB,
  CREATE_DEAL_JOB,
  LOG_NOTE_JOB,
} from './crm.constants';
import type { NotePayload } from './crm.interface';

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: true,
  removeOnFail: false,
};

@Injectable()
export class CrmService {
  private readonly logger = new Logger(CrmService.name);

  constructor(@InjectQueue(CRM_QUEUE) private readonly queue: Queue) {}

  async enqueueContactSync(client: ClientRecord): Promise<void> {
    await this.queue.add(SYNC_CONTACT_JOB, { client }, JOB_OPTS);
    this.logger.log(`Enqueued ${SYNC_CONTACT_JOB} for ${client.email}`);
  }

  async enqueueDealSync(
    contactId: string,
    email: string,
    classification: string,
    subject: string,
    company: string,
  ): Promise<void> {
    await this.queue.add(
      CREATE_DEAL_JOB,
      { contactId, email, classification, subject, company },
      JOB_OPTS,
    );
    this.logger.log(`Enqueued ${CREATE_DEAL_JOB} for contact ${contactId}`);
  }

  async enqueueEngagementNote(
    contactId: string,
    note: NotePayload,
  ): Promise<void> {
    await this.queue.add(LOG_NOTE_JOB, { contactId, note }, JOB_OPTS);
    this.logger.log(`Enqueued ${LOG_NOTE_JOB} for contact ${contactId}`);
  }
}
