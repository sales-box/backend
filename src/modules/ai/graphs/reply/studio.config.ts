import { MemorySaver } from '@langchain/langgraph';
import { ConfigService } from '@nestjs/config';
import { AiModelService } from '@/modules/ai/ai.model.service';
import { buildReplyGraph } from '@/modules/ai/graphs/reply/reply-graph.factory';

// LangGraph Studio runs OUTSIDE of NestJS — there is no DI container.
// We manually construct the same deps that NestJS would inject at runtime.

const config = new ConfigService(process.env);
const aiModelService = new AiModelService(config);

export const studioGraph = buildReplyGraph({
  aiModelService,
  checkpointer: new MemorySaver(),
});
