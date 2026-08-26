import { ReplyGraphStateType } from '@/modules/ai/graphs/reply/reply-graph.state';
import {
  COMPOSER_SYSTEM_PROMPT,
  COMPOSER_USER_PROMPT,
} from '@/modules/ai/graphs/reply/nodes/composer/composer.prompt';
import { ComposerSchema } from '@/modules/ai/graphs/reply/nodes/composer/composer.schema';
import { wrapUntrustedContent } from '@/common/security/untrusted-content.wrapper';
import { requirementsFromState } from '@/modules/ai/graphs/reply/nodes/matcher/matcher.node';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { PromptTemplate } from '@langchain/core/prompts';
import type { ReplyGraphDependencies } from '@/modules/ai/graphs/reply/reply-graph.factory';

export async function composerNode(
  state: ReplyGraphStateType,
  config: LangGraphRunnableConfig,
  deps: ReplyGraphDependencies,
): Promise<Partial<ReplyGraphStateType>> {
  const store = config.store;
  if (!store) {
    throw new Error('store is not configured');
  }

  const namespace = [
    'agent-instructions',
    'composer',
    state.tenantId,
    state.connectedAccountId,
  ];
  let userPreferences = '';
  const memory = await store.get(namespace, 'preferences');
  if (memory?.value?.instructions) {
    userPreferences = String(memory.value.instructions);
  }

  const systemPromptTemplate = PromptTemplate.fromTemplate(
    COMPOSER_SYSTEM_PROMPT,
  );
  const systemMessage = await systemPromptTemplate.format({
    userPreferences,
  });

  const body = wrapUntrustedContent(state.emailBody, 'email_body');

  const contextSections = [
    getRelatedProductChunks(state),
    getProvidedAttachments(state),
    getClientHistory(state),
  ];

  const userPromptTemplate = PromptTemplate.fromTemplate(COMPOSER_USER_PROMPT);
  const userMessage = await userPromptTemplate.format({
    emailBody: body,
    contextSections: contextSections.filter(Boolean).join('\n\n'),
  });

  const composerResult = await deps.aiModelService.generateStructured({
    schema: ComposerSchema,
    runName: 'ComposerNode',
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage },
    ],
  });

  return {
    composerResult,
  };
}

function getClientHistory(state: ReplyGraphStateType): string {
  const MAX_CLIENT_HISTORY_CHARS = 6_000;
  if (!state.clientHistory?.length) {
    return '<PriorClientHistory>First contact: no prior interactions.</PriorClientHistory>';
  }

  const history = state.clientHistory
    .slice(0, 5)
    .map((interaction) =>
      [
        `Date: ${interaction.date}`,
        `Type: ${interaction.type}`,
        `Subject: ${interaction.subject}`,
        `Summary: ${interaction.summary ?? ''}`,
        `Classification: ${interaction.classification ?? ''}`,
        `Previous recommendation: ${interaction.recommendation ?? ''}`,
      ].join(' | '),
    )
    .join('\n')
    .slice(0, MAX_CLIENT_HISTORY_CHARS);
  return `<PriorClientHistory>\n${wrapUntrustedContent(history, 'client_history')}\n</PriorClientHistory>`;
}

function getRelatedProductChunks(state: ReplyGraphStateType): string {
  const sections: string[] = [];

  if (state.intent) {
    const intentSection = `<ClientIntent>${state.intent}</ClientIntent>`;
    sections.push(intentSection);
  }

  const match = state.matchResult;

  if (match?.recommendedProduct) {
    const productSection = `
    <RecommendedProduct>
      Recommended Product: ${match.recommendedProduct}
      Reasoning: ${match.reasoning ?? 'N/A'}
    </RecommendedProduct>`;
    sections.push(productSection);
  } else if (match?.reasoning) {
    // The Matcher has two outputs. On a product inquiry it recommends a product
    // and explains why. On every other intent — support, follow-up, sensitive —
    // it hard-sets recommendedProduct to null (matcher.node.ts:424) and puts
    // the answer it retrieved from the knowledge base into `reasoning` alone.
    //
    // Gating the whole section behind recommendedProduct therefore threw that
    // answer away on exactly the threads where the knowledge base had already
    // done the work, and the Composer wrote its draft having never seen it.
    const answerSection = `
    <KnowledgeBaseAnswer>
      ${match.reasoning}
    </KnowledgeBaseAnswer>`;
    sections.push(answerSection);
  }

  const requirements = requirementsFromState(state);
  if (requirements.length > 0) {
    const requirementsSection = `
    <ClientRequirements>
      ${requirements.map((r) => `<Requirement>${r}</Requirement>`).join('\n')}
    </ClientRequirements>`;
    sections.push(requirementsSection);
  }

  if (match && match.citedChunkDetails.length > 0) {
    const chunksSection = `
    <CitedChunks>
      ${match.citedChunkDetails
        .map(
          (c) => `
        <Chunk id="${c.id}">
          ${c.content}
        </Chunk>`,
        )
        .join('\n')}
    </CitedChunks>`;

    sections.push(chunksSection);
  }

  return sections.join('\n');
}

function getProvidedAttachments(state: ReplyGraphStateType): string {
  if (!state.attachmentsText || state.attachmentsText.length === 0) {
    return '';
  }
  const entries = state.attachmentsText
    .map((text) => `<Attachment>\n${text}\n</Attachment>`)
    .join('\n');

  return `<ProvidedAttachments>\n${entries}\n</ProvidedAttachments>`;
}
