import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { ClientRecord } from '../clients/clients.interface';
import { CrmAdapterFactory } from './crm-adapter.factory';
import {
  CRM_QUEUE,
  CREATE_DEAL_JOB,
  LOG_NOTE_JOB,
  SYNC_CONTACT_JOB,
} from './crm.constants';
import type { NotePayload } from './crm.interface';

interface SyncContactJobData {
  tenantId: string;
  client: ClientRecord;
}

interface CreateDealJobData {
  tenantId: string;
  contactId: string;
  email: string;
  classification: string;
  subject: string;
  company: string;
}

interface LogNoteJobData {
  tenantId: string;
  contactId: string;
  note: NotePayload;
}

type CrmJobData = SyncContactJobData | CreateDealJobData | LogNoteJobData;

@Processor(CRM_QUEUE)
export class CrmProcessor extends WorkerHost {
  private readonly logger = new Logger(CrmProcessor.name);

  constructor(
    private readonly factory: CrmAdapterFactory,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<CrmJobData>): Promise<unknown> {
    const { tenantId } = job.data as { tenantId: string };
    const adapter = await this.factory.getAdapterForTenant(tenantId);
    if (!adapter) {
      this.logger.log(
        `No CRM adapter configured/connected for tenant ${tenantId}. Skipping job ${job.name} silently.`,
      );
      return {};
    }

    this.logger.log(
      `Processing ${job.name} job ${job.id} (attempt ${job.attemptsMade + 1})`,
    );

    switch (job.name) {
      case SYNC_CONTACT_JOB: {
        const { client } = job.data as SyncContactJobData;
        const contactId = await adapter.syncContact(client);

        await this.prisma.client.update({
          where: { id: client.id },
          data: { crmId: contactId },
        });
        this.logger.log(`Persisted crmId=${contactId} for client ${client.id}`);

        return { contactId };
      }

      case CREATE_DEAL_JOB: {
        const data = job.data as CreateDealJobData;
        const dealId = await adapter.createOrUpdateDeal(
          data.contactId,
          data.classification,
          data.subject,
          data.company,
        );

        await this.prisma.client.updateMany({
          where: { tenantId, email: data.email },
          data: { dealId },
        });
        this.logger.log(
          `Persisted dealId=${dealId} for ${data.email} under tenant ${tenantId}`,
        );

        return { dealId };
      }

      case LOG_NOTE_JOB: {
        const data = job.data as LogNoteJobData;
        await adapter.logEngagementNote(data.contactId, data.note);
        return { ok: true };
      }

      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
        return {};
    }
  }
}
