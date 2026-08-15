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

@Injectable()
export class AgentFactory {
  private readonly toolCache = new Map<
    string,
    {
      readTools: StructuredTool[];
      writeTools: StructuredTool[];
      mcpUrl: string;
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

  private async getToolsForTenant(tenantId: string) {
    const connection = await this.prisma.zohoMcpConnection.findUnique({
      where: { tenantId },
    });

    if (!connection || !connection.mcpServerUrl) {
      throw new NotFoundException(
        `No active Zoho MCP connection found for tenant: ${tenantId}`,
      );
    }

    const cachedTools = this.getToolsFromCache(tenantId, connection);

    if (cachedTools !== null) {
      return cachedTools;
    }

    const mcpClient = new MultiServerMCPClient({
      zoho: {
        transport: 'http',
        url: connection.mcpServerUrl,
      },
    });

    const allMcpTools: StructuredTool[] = await mcpClient.getTools();

    const { readTools, writeTools } = buildTools({
      searchRecords: this.findToolByName('ZohoCRM_searchRecords', allMcpTools),
      createRecords: this.findToolByName('ZohoCRM_createRecords', allMcpTools),
      updateRecords: this.findToolByName('ZohoCRM_updateRecords', allMcpTools),
    });

    this.toolCache.set(tenantId, {
      readTools,
      writeTools,
      mcpUrl: connection.mcpServerUrl,
      cachedAt: Date.now(),
    });

    return { readTools, writeTools };
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
    connection: { mcpServerUrl: string },
  ) {
    const cached = this.toolCache.get(tenantId);
    const isFresh = cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS;
    const isUrlUnchanged = cached?.mcpUrl === connection.mcpServerUrl;

    if (cached && isUrlUnchanged && isFresh) {
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
