import { AiModelService } from '@/modules/ai/ai.model.service';
import { ReplyGraphStateType } from '@/modules/ai/graphs/reply/reply-graph.state';
import {
  BaseStore,
  interrupt,
  LangGraphRunnableConfig,
} from '@langchain/langgraph';
import { PromptTemplate } from '@langchain/core/prompts';
import { FEEDBACK_PROMPT } from '@/modules/ai/graphs/reply/nodes/feedback/feedback.prompt';
import { UserPreferencesSchema } from '@/modules/ai/graphs/reply/nodes/feedback/feedback.schema';

export async function feedbackNode(
  state: ReplyGraphStateType,
  config: LangGraphRunnableConfig,
  aiModelService: AiModelService,
): Promise<Partial<ReplyGraphStateType>> {
  const store = config.store;
  if (!store) {
    throw new Error('store is not configured');
  }

  const originalDraft = state.composerResult?.draftText || '';

  const rawResponse: unknown = interrupt({
    action_request: 'Review Draft',
    draft: originalDraft,
  });
  const response = rawResponse as { content: string };

  const finalDraft = String(response.content);

  if (finalDraft !== originalDraft) {
    const newPreferences = await inferUserPreferences(
      state,
      aiModelService,
      store,
      originalDraft,
      finalDraft,
    );

    await updateUserPreferencesMemory(state, store, newPreferences);
  }

  return { finalDraft };
}

async function inferUserPreferences(
  state: ReplyGraphStateType,
  aiModelService: AiModelService,
  store: BaseStore,
  originalDraft: string,
  finalDraft: string,
): Promise<string> {
  const namespace = [
    'agent_instructions',
    'composer',
    state.tenantId,
    state.connectedAccountId,
  ];

  const memory = await store.get(namespace, 'preferences');
  const currentPreferences = String(
    memory?.value?.instructions || 'No preferences set',
  );

  const feedbackTemplate = PromptTemplate.fromTemplate(FEEDBACK_PROMPT);
  const feedbackMessage = await feedbackTemplate.format({
    currentPreferences,
    originalDraft,
    finalDraft,
  });

  const feedbackResult = await aiModelService.generateStructured({
    schema: UserPreferencesSchema,
    runName: 'FeedbackNode',
    messages: [{ role: 'user', content: feedbackMessage }],
  });

  return String(feedbackResult.instructions);
}

async function updateUserPreferencesMemory(
  state: ReplyGraphStateType,
  store: BaseStore,
  newPreferences: string,
): Promise<void> {
  console.log('🧠 SAVING NEW MEMORY:', newPreferences);
  const namespace = [
    'agent_instructions',
    'composer',
    state.tenantId,
    state.connectedAccountId,
  ];
  await store.put(namespace, 'preferences', { instructions: newPreferences });
}
