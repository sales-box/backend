import { MemorySaver, InMemoryStore } from '@langchain/langgraph';
import { ConfigService } from '@nestjs/config';
import { AiModelService } from '@/modules/ai/ai.model.service';
import { buildReplyGraph } from '@/modules/ai/graphs/reply/reply-graph.factory';
import { PrismaService } from '@/database/prisma.service';

// LangGraph Studio runs OUTSIDE of NestJS — there is no DI container.
// We manually construct the same deps that NestJS would inject at runtime.

const config = new ConfigService(process.env);
const aiModelService = new AiModelService(config);
const prisma = new PrismaService();

const replyGraph = buildReplyGraph({ aiModelService, prisma });

export const studioGraph = replyGraph.compile({
  checkpointer: new MemorySaver(),
  store: new InMemoryStore(),
});
