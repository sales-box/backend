import { AiModelService } from '@/modules/ai/ai.model.service';
import { ReplyGraphStateType } from '@/modules/ai/graphs/reply/reply-graph.state';
import {
  COMPOSER_SYSTEM_PROMPT,
  COMPOSER_USER_PROMPT,
} from '@/modules/ai/graphs/reply/nodes/composer/composer.prompt';
import { ComposerSchema } from '@/modules/ai/graphs/reply/nodes/composer/composer.schema';
import { wrapUntrustedContent } from '@/common/security/untrusted-content.wrapper';

export async function composerNode(
  state: ReplyGraphStateType,
  aiModelService: AiModelService,
): Promise<Partial<ReplyGraphStateType>> {
  const body = wrapUntrustedContent(state.emailBody, 'email_body');

  const userMessage = COMPOSER_USER_PROMPT.replace('{emailBody}', body)
    .replace('{requirements}', 'No requirements yet (mock)')
    .replace('{recommendedProduct}', 'N/A')
    .replace('{matcherReasoning}', 'N/A')
    .replace('{citedChunks}', 'No chunks available');

  const composerResult = await aiModelService.generateStructured({
    schema: ComposerSchema,
    runName: 'ComposerNode',
    messages: [
      { role: 'system', content: COMPOSER_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  });

  return {
    composerResult,
  };
}
