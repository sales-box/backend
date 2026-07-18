import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  BadRequestException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { ClientRecord } from '../clients/clients.interface';
import { ClientsService } from '../clients/clients.service';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService } from '../auth/crypto.service';
import { CrmAdapterFactory } from './crm-adapter.factory';
import { HubSpotAdapter } from './hubspot-crm.adapter';
import { MockCrmAdapter } from './mock-crm.adapter';
import { ConnectCrmDto } from './dto/connect-crm.dto';
import {
  CRM_QUEUE,
  SYNC_CONTACT_JOB,
  CREATE_DEAL_JOB,
  LOG_NOTE_JOB,
  CrmProvider,
} from './crm.constants';
import type { ICrmAdapter, NotePayload } from './crm.interface';

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: true,
  removeOnFail: false,
};

@Injectable()
export class CrmService {
  private readonly logger = new Logger(CrmService.name);

  constructor(
    @InjectQueue(CRM_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly factory: CrmAdapterFactory,
    @Inject(forwardRef(() => ClientsService))
    private readonly clientsService: ClientsService,
  ) {}

  async getCrmStatus(tenantId: string) {
    const connection = await this.prisma.crmConnection.findUnique({
      where: { tenantId },
    });

    if (!connection || connection.status !== 'connected') {
      return { connected: false, status: 'disconnected' };
    }

    return {
      connected: true,
      provider: connection.provider,
      status: connection.status,
      lastSync: connection.updatedAt,
    };
  }

  async connectCrm(tenantId: string, body: ConnectCrmDto) {
    let adapter: ICrmAdapter;
    if (body.provider === CrmProvider.HubSpot) {
      adapter = new HubSpotAdapter(body.apiKey);
    } else if (body.provider === CrmProvider.Mock) {
      adapter = new MockCrmAdapter();
    } else {
      throw new BadRequestException(
        `Unsupported CRM provider: ${body.provider as string}`,
      );
    }

    let contacts: Array<{
      email: string;
      name?: string;
      company?: string;
      crmId: string;
    }>;
    try {
      contacts = await adapter.fetchContacts();
    } catch (error) {
      throw new BadRequestException(
        `Failed to verify CRM connection: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const encryptedKey = this.crypto.encrypt(body.apiKey);
    const connection = await this.prisma.crmConnection.upsert({
      where: { tenantId },
      create: {
        tenantId,
        provider: body.provider,
        apiKey: encryptedKey,
        status: 'connected',
      },
      update: {
        provider: body.provider,
        apiKey: encryptedKey,
        status: 'connected',
      },
    });

    let importedCount = 0;
    for (const contact of contacts) {
      try {
        await this.clientsService.getOrCreateClient(
          tenantId,
          contact.email,
          contact.name,
          contact.company,
          contact.crmId,
        );
        importedCount++;
      } catch (err) {
        this.logger.error(
          `Failed to import contact ${contact.email}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      message: `CRM connected successfully — imported ${importedCount} clients. Now upload your product catalog.`,
      importedCount,
      status: connection.status,
    };
  }

  async disconnectCrm(tenantId: string) {
    const connection = await this.prisma.crmConnection.findUnique({
      where: { tenantId },
    });

    // Idempotent: disconnecting an already-disconnected tenant is not an error.
    if (!connection) {
      return {
        message: 'No CRM connection to disconnect.',
        removedClients: 0,
        status: 'disconnected',
      };
    }
    const [removed] = await this.prisma.$transaction([
      this.prisma.client.deleteMany({
        where: { tenantId, crmId: { not: null } },
      }),
      this.prisma.crmConnection.delete({
        where: { tenantId },
      }),
    ]);

    this.logger.log(
      `Disconnected CRM for tenant ${tenantId} — removed ${removed.count} imported client(s)`,
    );

    return {
      message: `CRM disconnected — removed ${removed.count} imported clients.`,
      removedClients: removed.count,
      status: 'disconnected',
    };
  }

  async enqueueContactSync(
    tenantId: string,
    client: ClientRecord,
  ): Promise<void> {
    await this.queue.add(SYNC_CONTACT_JOB, { tenantId, client }, JOB_OPTS);
    this.logger.log(
      `Enqueued ${SYNC_CONTACT_JOB} for ${client.email} (tenant: ${tenantId})`,
    );
  }

  async enqueueDealSync(
    tenantId: string,
    contactId: string,
    email: string,
    classification: string,
    subject: string,
    company: string,
  ): Promise<void> {
    await this.queue.add(
      CREATE_DEAL_JOB,
      { tenantId, contactId, email, classification, subject, company },
      JOB_OPTS,
    );
    this.logger.log(
      `Enqueued ${CREATE_DEAL_JOB} for contact ${contactId} (tenant: ${tenantId})`,
    );
  }

  async enqueueEngagementNote(
    tenantId: string,
    contactId: string,
    note: NotePayload,
  ): Promise<void> {
    await this.queue.add(LOG_NOTE_JOB, { tenantId, contactId, note }, JOB_OPTS);
    this.logger.log(
      `Enqueued ${LOG_NOTE_JOB} for contact ${contactId} (tenant: ${tenantId})`,
    );
  }
}
