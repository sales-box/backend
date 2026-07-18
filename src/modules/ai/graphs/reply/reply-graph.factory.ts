import { AiModelService } from '@/modules/ai/ai.model.service';
import { ReplyGraphState } from '@/modules/ai/graphs/reply/reply-graph.state';
import { extractorNode } from '@/modules/ai/graphs/reply/nodes/extractor/extractor.node';
import { StateGraph, START, END } from '@langchain/langgraph';
import { composerNode } from '@/modules/ai/graphs/reply/nodes/composer/composer.node';
import { matcherNode } from '@/modules/ai/graphs/reply/nodes/matcher/matcher.node';
import { feedbackNode } from '@/modules/ai/graphs/reply/nodes/feedback/feedback.node';
import { PrismaService } from '@/database/prisma.service';

export interface ReplyGraphDependencies {
  aiModelService: AiModelService;
  prisma: PrismaService;
}

export function buildReplyGraph(deps: ReplyGraphDependencies) {
  return new StateGraph(ReplyGraphState)
    .addNode('extract', (state) => extractorNode(state, deps.aiModelService))
    .addNode('match', (state) => matcherNode(state, deps))
    .addNode('compose', (state, config) =>
      composerNode(state, config, deps.aiModelService),
    )
    .addNode('feedback', (state, config) =>
      feedbackNode(state, config, deps.aiModelService),
    )
    .addEdge(START, 'extract')
    .addEdge('extract', 'match')
    .addEdge('match', 'compose')
    .addEdge('compose', 'feedback')
    .addEdge('feedback', END);
}
