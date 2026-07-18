import { AiModelService } from '@/modules/ai/ai.model.service';
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

export async function composerNode(
  state: ReplyGraphStateType,
  config: LangGraphRunnableConfig,
  aiModelService: AiModelService,
): Promise<Partial<ReplyGraphStateType>> {
  const store = config.store;
  if (!store) {
    throw new Error('store is not configured');
  }

  const namespace = [
    'agent_instructions',
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
    getThreadHistory(),
    getClientBackground(),
    getRelatedProductChunks(state),
    getProvidedAttachments(),
  ];

  const userPromptTemplate = PromptTemplate.fromTemplate(COMPOSER_USER_PROMPT);
  const userMessage = await userPromptTemplate.format({
    emailBody: body,
    contextSections: contextSections.filter(Boolean).join('\n\n'),
  });

  const composerResult = await aiModelService.generateStructured({
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

// from parsed messages in DB
function getThreadHistory() {
  return `
<ThreadHistory>
Date: 2026-07-10
From: client@example.com
Message: We are looking for a new CRM system that supports custom API integrations and has role-based access control.

Date: 2026-07-12
From: sales@ourcompany.com
Message: Thanks for reaching out! We have a few options. How many users will be on the platform?
</ThreadHistory>
  `.trim();
}

// from CRM system.
function getClientBackground() {
  return `
<ClientBackground>
Company: TechFlow Inc.
Industry: Software Development
Size: 50-200 employees
Current Status: Evaluating vendors for Q3 implementation. They prioritize security and API flexibility.
</ClientBackground>
  `.trim();
}

// from matcher node work
function getRelatedProductChunks(state: ReplyGraphStateType) {
  const sections: string[] = [];

  if (state.intent) {
    const intentSection = `<ClientIntent>${state.intent}</ClientIntent>`;
    sections.push(intentSection);
  }

  const match = state.matchResult;

  if (match && match.recommendedProduct) {
    const productSection = `
    <RecommendedProduct>
      Recommended Product: ${match.recommendedProduct}
      Reasoning: ${match.reasoning ?? 'N/A'}
    </RecommendedProduct>`;
    sections.push(productSection);
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

// from email processed attachments
function getProvidedAttachments() {
  return `
<ProvidedAttachments>
Filename: requirements_v2.pdf
Summary: The client requires a minimum of 99.9% uptime SLA, SOC2 compliance, and dedicated account management.
</ProvidedAttachments>
  `.trim();
}
