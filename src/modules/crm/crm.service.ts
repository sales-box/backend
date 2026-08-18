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
import { verifyZohoMcpServer } from './zoho-mcp.verify';
import { ConnectCrmDto } from './dto/connect-crm.dto';
import { ConnectZohoMcpDto } from './dto/connect-zoho-mcp.dto';
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

  async getMcpConnectionStatus(tenantId: string) {
    const connection = await this.prisma.crmAgentConnection.findUnique({
      where: { tenantId },
    });

    // Reported per provider, because the panel needs to know WHICH CRM the
    // agent will write to, not merely that some connection exists.
    if (!connection) {
      return { connected: false };
    }

    return {
      connected: true,
      provider: connection.provider,
      updatedAt: connection.updatedAt,
    };
  }

  async connectZohoMcp(tenantId: string, body: ConnectZohoMcpDto) {
    await this.assertNoOtherAgentCrm(tenantId, CrmProvider.Zoho);

    // Verify before claiming success. This used to be a bare upsert that
    // returned "connection established successfully" for any string at all,
    // so a typo'd or expired URL looked connected until the first email came
    // in and the agent failed with a 404 nobody could trace back to here.
    try {
      await verifyZohoMcpServer(body.mcpServerUrl);
    } catch (error) {
      throw new BadRequestException(
        `Could not connect to Zoho: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const connection = await this.prisma.crmAgentConnection.upsert({
      where: { tenantId },
      create: {
        tenantId,
        provider: CrmProvider.Zoho,
        mcpServerUrl: body.mcpServerUrl,
      },
      update: {
        provider: CrmProvider.Zoho,
        mcpServerUrl: body.mcpServerUrl,
      },
    });

    return {
      message: 'Zoho MCP connection established successfully.',
      connected: true,
      mcpServerUrl: connection.mcpServerUrl,
    };
  }

  async disconnectZohoMcp(tenantId: string) {
    await this.prisma.crmAgentConnection.deleteMany({
      where: { tenantId },
    });

    return {
      message: 'Zoho MCP disconnected successfully.',
      connected: false,
    };
  }

  /**
   * One CRM per tenant, enforced rather than assumed.
   *
   * Nothing stopped a tenant connecting Zoho and HubSpot at once, and the agent
   * would then write to whichever provider happened to be on the row — a
   * silent coin toss over someone's CRM. Organisations use one or the other, so
   * the second connection is refused and the fix is named.
   */
  private async assertNoOtherAgentCrm(
    tenantId: string,
    provider: CrmProvider,
  ): Promise<void> {
    const existing = await this.prisma.crmAgentConnection.findUnique({
      where: { tenantId },
      select: { provider: true },
    });

    if (existing && existing.provider !== (provider as string)) {
      throw new BadRequestException(
        `${existing.provider} is already connected as this workspace's CRM. ` +
          `Disconnect it before connecting ${provider}.`,
      );
    }
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

    await this.assertNoOtherAgentCrm(tenantId, body.provider);

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

    // Connecting means connected. The agent reads crm_agent_connections to
    // learn which CRM to write to, and this flow never wrote to it — so a
    // tenant could connect HubSpot in the dashboard, see "Connected", and
    // still get "No CRM connection found" from the agent. Verification has
    // already succeeded above, so this row is earned.
    if (body.provider !== CrmProvider.Mock) {
      await this.prisma.crmAgentConnection.upsert({
        where: { tenantId },
        create: { tenantId, provider: body.provider, mcpServerUrl: null },
        update: { provider: body.provider, mcpServerUrl: null },
      });
    }

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
    // Unlink, do not delete.
    //
    // This used to be `client.deleteMany({ crmId: { not: null } })`, and
    // Interaction cascades on Client, so disconnecting a CRM destroyed every
    // conversation we had ever recorded with those people. That history is
    // ours — it is built from the tenant's own mail, and the CRM only ever
    // supplied the name and email to hang it on. Deleting it silently reset
    // clientHistoryConfidence to the floor and degraded reply routing with no
    // explanation. Observed live: a disconnect/reconnect took a client from
    // five logged interactions to zero.
    //
    // Clearing crmId leaves the client as a locally-owned record with its
    // history intact. Reconnecting re-matches by email in getOrCreateClient
    // and puts the crmId back on the same row.
    const [unlinked] = await this.prisma.$transaction([
      this.prisma.client.updateMany({
        where: { tenantId, crmId: { not: null } },
        data: { crmId: null },
      }),
      this.prisma.crmConnection.delete({
        where: { tenantId },
      }),
      // The credential is gone, so the agent must stop pointing at it. Leaving
      // the row behind would have the agent try to build tools from a
      // connection that no longer exists.
      this.prisma.crmAgentConnection.deleteMany({
        where: { tenantId, provider: connection.provider },
      }),
    ]);

    this.logger.log(
      `Disconnected CRM for tenant ${tenantId} — unlinked ${unlinked.count} client(s), history kept`,
    );

    return {
      message: `CRM disconnected — ${unlinked.count} clients kept with their history.`,
      removedClients: unlinked.count,
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
