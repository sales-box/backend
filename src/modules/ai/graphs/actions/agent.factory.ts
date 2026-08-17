import { Inject, Injectable, NotFoundException } from '@nestjs/common';
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
import { ZOHO_OBJECT_MODEL, type CrmObjectModel } from './agent.prompt';

@Injectable()
export class AgentFactory {
  private readonly toolCache = new Map<
    string,
    {
      readTools: StructuredTool[];
      writeTools: StructuredTool[];
      provider: string;
      mcpUrl: string | null;
      cachedAt: number;
    }
  >();

  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(
    private readonly aiModelService: AiModelService,
    private readonly prisma: PrismaService,
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

    const cachedTools = this.getToolsFromCache(tenantId, connection);
    if (cachedTools !== null) {
      return cachedTools;
    }

    const { readTools, writeTools } = await this.buildToolsForProvider(
      connection.provider,
      connection.mcpServerUrl,
      tenantId,
    );

    this.toolCache.set(tenantId, {
      readTools,
      writeTools,
      provider: connection.provider,
      mcpUrl: connection.mcpServerUrl,
      cachedAt: Date.now(),
    });

    return { readTools, writeTools };
  }

  /**
   * The prompt half of the same branch. Kept beside `buildToolsForProvider` so
   * a new CRM is one edit in one place: tools and object model together, never
   * one without the other.
   */
  public async getObjectModelForTenant(
    tenantId: string,
  ): Promise<CrmObjectModel> {
    const connection = await this.prisma.crmAgentConnection.findUnique({
      where: { tenantId },
      select: { provider: true },
    });

    if (connection?.provider === (CrmProvider.Zoho as string)) {
      return ZOHO_OBJECT_MODEL;
    }

    throw new NotFoundException(
      `No CRM object model for provider "${connection?.provider ?? 'none'}" (tenant: ${tenantId})`,
    );
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
      return buildTools(await this.zohoPrimitives(mcpServerUrl));
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
      return { readTools: cached.readTools, writeTools: cached.writeTools };
    }

    return null;
  }

  private findToolByName(name: string, allMcpTools: StructuredTool[]) {
    const t = allMcpTools.find((t) => t.name === name);
    if (!t) throw new Error(`Required MCP tool not found on server: ${name}`);
    return t;
  }
}
