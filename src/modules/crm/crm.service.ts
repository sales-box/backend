import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  BadRequestException,
} from '@nestjs/common';
import { ClientsService } from '../clients/clients.service';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService } from '../auth/crypto.service';
import { HubSpotAdapter } from './hubspot-crm.adapter';
import { MockCrmAdapter } from './mock-crm.adapter';
import { verifyZohoMcpServer } from './zoho-mcp.verify';
import { ZohoMcpAdapter } from './zoho-crm.adapter';
import { ConnectCrmDto } from './dto/connect-crm.dto';
import { ConnectZohoMcpDto } from './dto/connect-zoho-mcp.dto';
import { CrmProvider } from './crm.constants';
import type { CrmContact, ICrmAdapter } from './crm.interface';

@Injectable()
export class CrmService {
  private readonly logger = new Logger(CrmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
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

    // The panel used to read this off the connect mutation's response, so a
    // reload showed 0 synced contacts for a workspace with hundreds. Count the
    // rows that actually carry a CRM id instead.
    const importedCount = await this.prisma.client.count({
      where: { tenantId, crmId: { not: null } },
    });

    return {
      connected: true,
      provider: connection.provider,
      status: connection.status,
      lastSync: connection.updatedAt,
      importedCount,
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

    // Read the address book before claiming a connection, exactly as the
    // HubSpot path does. Zoho used to stop at verification, so a connected
    // Zoho workspace showed an empty Clients page for ever.
    const adapter = new ZohoMcpAdapter(body.mcpServerUrl);
    let contacts: CrmContact[];
    try {
      contacts = await adapter.fetchContacts();
    } catch (error) {
      throw new BadRequestException(
        `Failed to verify CRM connection: ${error instanceof Error ? error.message : String(error)}`,
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

    // The credential row too. Everything keyed off crm_connections —
    // getCrmStatus, importedCount, disconnectCrm — was blind to Zoho without
    // it. The MCP URL is the credential here, so it is encrypted like a key.
    await this.prisma.crmConnection.upsert({
      where: { tenantId },
      create: {
        tenantId,
        provider: CrmProvider.Zoho,
        apiKey: this.crypto.encrypt(body.mcpServerUrl),
        status: 'connected',
      },
      update: {
        provider: CrmProvider.Zoho,
        apiKey: this.crypto.encrypt(body.mcpServerUrl),
        status: 'connected',
      },
    });

    const importedCount = await this.importContacts(tenantId, contacts);

    return {
      message: `Zoho MCP connected successfully — imported ${importedCount} clients.`,
      connected: true,
      importedCount,
      mcpServerUrl: connection.mcpServerUrl,
    };
  }

  async disconnectZohoMcp(tenantId: string) {
    // The same disconnect HubSpot gets: unlink the clients, keep their
    // history, drop the credential and the agent row. Zoho now imports
    // clients, so anything less would leave them orphaned with a stale crmId.
    const result = await this.disconnectCrm(tenantId);

    // A workspace connected before Zoho wrote crm_connections has only the
    // agent row, and disconnectCrm returns early on it. Scoped, so a HubSpot
    // row is never caught by this — the unscoped delete that used to be here
    // took HubSpot's row down while the dashboard still read "Connected".
    await this.prisma.crmAgentConnection.deleteMany({
      where: { tenantId, provider: CrmProvider.Zoho },
    });

    return {
      message: 'Zoho MCP disconnected successfully.',
      connected: false,
      removedClients: result.removedClients,
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

    let contacts: CrmContact[];
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

    const importedCount = await this.importContacts(tenantId, contacts);

    return {
      message: `CRM connected successfully — imported ${importedCount} clients. Now upload your product catalog.`,
      importedCount,
      status: connection.status,
    };
  }

  /**
   * Write a provider's contacts into the local clients table.
   *
   * Shared by every provider so an import cannot drift between them: one
   * contact that fails is logged and skipped rather than failing the connect,
   * because a partial address book still beats none.
   */
  private async importContacts(
    tenantId: string,
    contacts: CrmContact[],
  ): Promise<number> {
    let importedCount = 0;
    for (const contact of contacts) {
      try {
        await this.clientsService.getOrCreateClient(
          tenantId,
          contact.email,
          contact.name,
          contact.company,
          contact.crmId,
          contact.status,
        );
        importedCount++;
      } catch (err) {
        this.logger.error(
          `Failed to import contact ${contact.email}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return importedCount;
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
}
