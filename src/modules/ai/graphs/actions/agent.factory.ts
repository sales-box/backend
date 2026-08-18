import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  createAgent,
  piiMiddleware,
  StructuredTool,
  toolCallLimitMiddleware,
} from 'langchain';
import { promptInjectionMiddleware } from './prompt-injection.middleware';
import { humanInTheLoopMiddleware } from './hitl.middleware';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { PrismaService } from '@/database/prisma.service';
import { AiModelService } from '@/modules/ai/ai.model.service';
import { CHECKPOINTER_TOKEN } from '../checkpointer/checkpointer.constants';
import { buildTools } from './tools.factory';
import { CrmProvider } from '@/modules/crm/crm.constants';
import {
  ZOHO_OBJECT_MODEL,
  buildHubSpotObjectModel,
  type CrmObjectModel,
} from './agent.prompt';
import { Client } from '@hubspot/api-client';
import { CryptoService } from '@/modules/auth/crypto.service';
import {
  buildHubSpotTools,
  fetchDealStages,
  fetchSoleOwnerId,
  probeTicketsAvailable,
} from './hubspot-tools.factory';

@Injectable()
export class AgentFactory {
  private readonly logger = new Logger(AgentFactory.name);

  private readonly toolCache = new Map<
    string,
    {
      readTools: StructuredTool[];
      writeTools: StructuredTool[];
      objectModel: CrmObjectModel;
      provider: string;
      mcpUrl: string | null;
      cachedAt: number;
    }
  >();

  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(
    private readonly aiModelService: AiModelService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    @Inject(CHECKPOINTER_TOKEN) private readonly checkpointer: PostgresSaver,
  ) {}

  public async createAgentForTenant(tenantId: string) {
    const { readTools, writeTools } = await this.getToolsForTenant(tenantId);

    const interruptOn = this.getInterruptOnConfig(readTools, writeTools);

    const agent = createAgent({
      model: this.aiModelService.getChatModel(),
      tools: [...readTools, ...writeTools],
      middleware: [
        promptInjectionMiddleware(),

        piiMiddleware('credit_card', {
          strategy: 'mask',
          applyToInput: true,
        }),

        piiMiddleware('api_key', {
          detector: 'sk-[a-zA-Z0-9]{32}',
          strategy: 'mask',
          applyToInput: true,
        }),

        humanInTheLoopMiddleware({
          interruptOn,
          descriptionPrefix: 'CRM Write Tool execution pending approval',
        }),

        toolCallLimitMiddleware({ runLimit: 15, exitBehavior: 'continue' }),
      ],
      checkpointer: this.checkpointer,
    });

    return agent;
  }

  /**
   * The one place the supported CRMs differ.
   *
   * Everything downstream — the middleware chain, the approval gate, the
   * checkpointer — consumes `{ readTools, writeTools }` and never learns which
   * provider produced them. Adding a CRM means adding a builder and a branch
   * here; nothing else in this file changes.
   */
  private async getToolsForTenant(tenantId: string) {
    const connection = await this.prisma.crmAgentConnection.findUnique({
      where: { tenantId },
    });

    if (!connection) {
      throw new NotFoundException(
        `No CRM connection found for tenant: ${tenantId}`,
      );
    }

    const cached = this.getToolsFromCache(tenantId, connection);
    if (cached !== null) {
      return cached;
    }

    const built = await this.buildToolsForProvider(
      connection.provider,
      connection.mcpServerUrl,
      tenantId,
    );

    this.toolCache.set(tenantId, {
      ...built,
      provider: connection.provider,
      mcpUrl: connection.mcpServerUrl,
      cachedAt: Date.now(),
    });

    return built;
  }

  /**
   * The prompt half of the same build.
   *
   * This deliberately goes through `getToolsForTenant` rather than re-deriving
   * the model from the provider name. On HubSpot the model depends on what the
   * portal can actually do — a portal without Tickets gets a prompt that routes
   * escalations to Notes — and deriving it separately would eventually let the
   * prompt describe a tool that was not built.
   */
  public async getObjectModelForTenant(
    tenantId: string,
  ): Promise<CrmObjectModel> {
    const { objectModel } = await this.getToolsForTenant(tenantId);
    return objectModel;
  }

  private async buildToolsForProvider(
    provider: string,
    mcpServerUrl: string | null,
    tenantId: string,
  ) {
    if (provider === (CrmProvider.Zoho as string)) {
      if (!mcpServerUrl) {
        throw new NotFoundException(
          `Zoho is connected for tenant ${tenantId} but carries no MCP server URL`,
        );
      }
      return {
        ...buildTools(await this.zohoPrimitives(mcpServerUrl)),
        objectModel: ZOHO_OBJECT_MODEL,
      };
    }

    if (provider === (CrmProvider.HubSpot as string)) {
      const ctx = await this.hubSpotContext(tenantId);
      return {
        ...buildHubSpotTools(ctx),
        objectModel: buildHubSpotObjectModel({
          ticketsAvailable: ctx.ticketsAvailable,
        }),
      };
    }

    throw new NotFoundException(
      `CRM provider "${provider}" has no action tools for tenant: ${tenantId}`,
    );
  }

  /** The three primitives, as exposed by Zoho's MCP server. */
  private async zohoPrimitives(mcpServerUrl: string) {
    const mcpClient = new MultiServerMCPClient({
      zoho: { transport: 'http', url: mcpServerUrl },
    });

    const allMcpTools: StructuredTool[] = await mcpClient.getTools();

    return {
      searchRecords: this.findToolByName('ZohoCRM_searchRecords', allMcpTools),
      createRecords: this.findToolByName('ZohoCRM_createRecords', allMcpTools),
      updateRecords: this.findToolByName('ZohoCRM_updateRecords', allMcpTools),
    };
  }

  /**
   * HubSpot is reached over its REST API with the private app token the tenant
   * already gave us on `crm_connections`, so there is no MCP server and no URL
   * on the agent connection row.
   */
  private async hubSpotContext(tenantId: string) {
    const connection = await this.prisma.crmConnection.findUnique({
      where: { tenantId },
    });

    if (!connection || connection.status !== 'connected') {
      throw new NotFoundException(
        `HubSpot is the action CRM for tenant ${tenantId} but no connected HubSpot credential exists`,
      );
    }

    const client = new Client({
      accessToken: this.crypto.decrypt(connection.apiKey),
    });

    // Read once, cached with the tools. Deal stage ids are per-portal, so the
    // deal tool cannot be built without them.
    // These probes run once per cache fill, not per email.
    const [ticketsAvailable, defaultOwnerId] = await Promise.all([
      probeTicketsAvailable(client),
      fetchSoleOwnerId(client),
    ]);
    if (!ticketsAvailable) {
      this.logger.warn(
        `HubSpot portal for tenant ${tenantId} cannot use Tickets — ` +
          'dropping createTicket and routing escalations to Notes.',
      );
    }

    let dealStages: Awaited<ReturnType<typeof fetchDealStages>> = [];
    try {
      dealStages = await fetchDealStages(client);
    } catch (error) {
      // Losing deals is bad; losing every other action because the pipelines
      // endpoint is unavailable is worse. buildHubSpotTools drops the deal tool
      // when the list is empty.
      this.logger.warn(
        `Could not read HubSpot deal stages for tenant ${tenantId}: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'Continuing without the createDeal tool.',
      );
    }

    return { client, dealStages, ticketsAvailable, defaultOwnerId };
  }

  private getInterruptOnConfig(
    readTools: StructuredTool[],
    writeTools: StructuredTool[],
  ) {
    const interruptOn: Record<
      string,
      boolean | { allowedDecisions: ('approve' | 'reject')[] }
    > = {};
    readTools.forEach((t) => {
      interruptOn[t.name] = false;
    });
    writeTools.forEach((t) => {
      interruptOn[t.name] = { allowedDecisions: ['approve', 'reject'] };
    });
    return interruptOn;
  }

  private getToolsFromCache(
    tenantId: string,
    connection: { provider: string; mcpServerUrl: string | null },
  ) {
    const cached = this.toolCache.get(tenantId);
    const isFresh = cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS;
    const isUrlUnchanged = cached?.mcpUrl === connection.mcpServerUrl;
    // Switching CRM must not serve the previous provider's tools for the rest
    // of the TTL — the URL alone would not catch a swap to a provider that
    // carries no URL at all.
    const isSameProvider = cached?.provider === connection.provider;

    if (cached && isSameProvider && isUrlUnchanged && isFresh) {
      return {
        readTools: cached.readTools,
        writeTools: cached.writeTools,
        objectModel: cached.objectModel,
      };
    }

    return null;
  }

  private findToolByName(name: string, allMcpTools: StructuredTool[]) {
    const t = allMcpTools.find((t) => t.name === name);
    if (!t) throw new Error(`Required MCP tool not found on server: ${name}`);
    return t;
  }
}
