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
  const match = state.matchResult;

  // recommendedProduct is null on the answer path — the client asked a
  // question and no product was chosen. Never interpolate "N/A" into a
  // customer-facing draft; instruct the model instead.
  const productLine = match?.recommendedProduct
    ? match.recommendedProduct
    : 'None — answer the client’s question; do not pitch a product.';

  const chunksBlock = match?.citedChunkDetails.length
    ? match.citedChunkDetails
        .map((c) => `[chunk ${c.id}]\n${c.content}`)
        .join('\n\n')
    : 'No chunks available';

  const userMessage = COMPOSER_USER_PROMPT.replace(
    '{intent}',
    state.intent ?? 'unknown',
  )
    .replace('{emailBody}', body)
    .replace(
      '{requirements}',
      state.requirements?.length
        ? state.requirements.map((r) => `- ${r}`).join('\n')
        : 'None provided',
    )
    .replace('{recommendedProduct}', productLine)
    .replace('{matcherReasoning}', match?.reasoning ?? 'N/A')
    .replace('{productChunks}', chunksBlock);

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
