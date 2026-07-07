import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ClientRecord } from '../clients/clients.interface';
import { CRM_QUEUE, SYNC_CONTACT_JOB } from './crm.constants';

@Injectable()
export class CrmService {
  private readonly logger = new Logger(CrmService.name);

  constructor(@InjectQueue(CRM_QUEUE) private readonly queue: Queue) {}

  async enqueueContactSync(client: ClientRecord): Promise<void> {
    await this.queue.add(
      SYNC_CONTACT_JOB,
      { client },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    this.logger.log(`Enqueued ${SYNC_CONTACT_JOB} for ${client.email}`);
  }
}
