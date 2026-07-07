import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ClientRecord } from '../clients/clients.interface';
import { CRM_ADAPTER, CRM_QUEUE } from './crm.constants';
import type { ICrmAdapter } from './crm.interface';

interface SyncContactJobData {
  client: ClientRecord;
}

@Processor(CRM_QUEUE)
export class CrmProcessor extends WorkerHost {
  private readonly logger = new Logger(CrmProcessor.name);

  constructor(@Inject(CRM_ADAPTER) private readonly adapter: ICrmAdapter) {
    super();
  }

  async process(job: Job<SyncContactJobData>): Promise<{ contactId: string }> {
    const { client } = job.data;
    this.logger.log(
      `Processing ${CRM_QUEUE} job ${job.id} (attempt ${job.attemptsMade + 1}) for ${client.email}`,
    );

    const contactId = await this.adapter.syncContact(client);
    return { contactId };
  }
}
