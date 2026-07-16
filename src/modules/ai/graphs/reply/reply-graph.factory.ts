import { AiModelService } from '@/modules/ai/ai.model.service';
import { ReplyGraphState } from '@/modules/ai/graphs/reply/reply-graph.state';
import {
  StateGraph,
  START,
  END,
  BaseCheckpointSaver,
} from '@langchain/langgraph';
import { composerNode } from '@/modules/ai/graphs/reply/nodes/composer/composer.node';
import { matcherNode } from '@/modules/ai/graphs/reply/nodes/matcher/matcher.node';
import { PrismaService } from '@/database/prisma.service';

export interface ReplyGraphDependencies {
  aiModelService: AiModelService;
  // Required, not optional: the matcher node's retrieval SQL cannot run
  // without it, and a required field makes the compiler find every caller.
  prisma: PrismaService;
  checkpointer?: BaseCheckpointSaver;
}

export function buildReplyGraph(deps: ReplyGraphDependencies) {
  return new StateGraph(ReplyGraphState)
    .addNode('match', (state) => matcherNode(state, deps))
    .addNode('compose', (state) => composerNode(state, deps.aiModelService))
    .addEdge(START, 'match')
    .addEdge('match', 'compose')
    .addEdge('compose', END)
    .compile({ checkpointer: deps.checkpointer });
}
