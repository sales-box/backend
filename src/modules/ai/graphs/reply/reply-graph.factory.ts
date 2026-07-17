import { AiModelService } from '@/modules/ai/ai.model.service';
import { ReplyGraphState } from '@/modules/ai/graphs/reply/reply-graph.state';
import { extractorNode } from '@/modules/ai/graphs/reply/nodes/extractor/extractor.node';
import {
  StateGraph,
  START,
  END,
  BaseCheckpointSaver,
} from '@langchain/langgraph';
import { composerNode } from '@/modules/ai/graphs/reply/nodes/composer/composer.node';

export interface ReplyGraphDependencies {
  aiModelService: AiModelService;
  checkpointer?: BaseCheckpointSaver;
}

export function buildReplyGraph(deps: ReplyGraphDependencies) {
  return new StateGraph(ReplyGraphState)
    .addNode('extract', (state) => extractorNode(state, deps.aiModelService))
    .addNode('compose', (state) => composerNode(state, deps.aiModelService))
    .addEdge(START, 'extract')
    .addEdge('extract', 'compose')
    .addEdge('compose', END)
    .compile({ checkpointer: deps.checkpointer });
}
