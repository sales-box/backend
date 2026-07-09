import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { ClientRecord } from '../clients/clients.interface';
import {
  CRM_ADAPTER,
  CRM_QUEUE,
  CREATE_DEAL_JOB,
  LOG_NOTE_JOB,
  SYNC_CONTACT_JOB,
} from './crm.constants';
import type { ICrmAdapter, NotePayload } from './crm.interface';

interface SyncContactJobData {
  client: ClientRecord;
}

interface CreateDealJobData {
  contactId: string;
  email: string;
  classification: string;
  subject: string;
  company: string;
}

interface LogNoteJobData {
  contactId: string;
  note: NotePayload;
}

type CrmJobData = SyncContactJobData | CreateDealJobData | LogNoteJobData;

@Processor(CRM_QUEUE)
export class CrmProcessor extends WorkerHost {
  private readonly logger = new Logger(CrmProcessor.name);

  constructor(
    @Inject(CRM_ADAPTER) private readonly adapter: ICrmAdapter,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<CrmJobData>): Promise<unknown> {
    this.logger.log(
      `Processing ${job.name} job ${job.id} (attempt ${job.attemptsMade + 1})`,
    );

    switch (job.name) {
      case SYNC_CONTACT_JOB: {
        const { client } = job.data as SyncContactJobData;
        const contactId = await this.adapter.syncContact(client);

        await this.prisma.client.update({
          where: { email: client.email },
          data: { crmId: contactId },
        });
        this.logger.log(`Persisted crmId=${contactId} for ${client.email}`);

        return { contactId };
      }

      case CREATE_DEAL_JOB: {
        const data = job.data as CreateDealJobData;
        const dealId = await this.adapter.createOrUpdateDeal(
          data.contactId,
          data.classification,
          data.subject,
          data.company,
        );

        await this.prisma.client.update({
          where: { email: data.email },
          data: { dealId },
        });
        this.logger.log(`Persisted dealId=${dealId} for ${data.email}`);

        return { dealId };
      }

      case LOG_NOTE_JOB: {
        const data = job.data as LogNoteJobData;
        await this.adapter.logEngagementNote(data.contactId, data.note);
        return { ok: true };
      }

      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
        return {};
    }
  }
}
