// src/modules/ai/graphs/reply/nodes/extractor/extractor.node.ts
import { AiModelService } from '@/modules/ai/ai.model.service';
import { ReplyGraphStateType } from '@/modules/ai/graphs/reply/reply-graph.state';
import { wrapUntrustedContent } from '@/common/security/untrusted-content.wrapper';
import { flagSuspiciousContent } from '@/common/security/prompt-injection-prefilter';
import { ExtractorSchema } from './extractor.schema';
import {
  EXTRACTOR_SYSTEM_PROMPT,
  EXTRACTOR_USER_PROMPT_TEMPLATE,
} from './extractor.prompt';

const MAX_EXTERNAL_CONTENT_CHARS = 3500;

function safeWrap(
  content: string,
  source: 'email_body' | 'attachment_text' | 'google_drive',
): string {
  flagSuspiciousContent(content);
  const caged = content.replace(
    /<\s*\/?\s*untrusted_content[^>]*>/gi,
    '[filtered]',
  );
  return wrapUntrustedContent(caged, source);
}

function truncate(text: string): string {
  return text.length > MAX_EXTERNAL_CONTENT_CHARS
    ? `${text.slice(0, MAX_EXTERNAL_CONTENT_CHARS)}\n[...truncated]`
    : text;
}

export async function extractorNode(
  state: ReplyGraphStateType,
  aiModelService: AiModelService,
): Promise<Partial<ReplyGraphStateType>> {
  const wrappedEmail = safeWrap(state.emailBody, 'email_body');
  const wrappedAttachments = state.attachmentsText
    .map((t) => safeWrap(t, 'attachment_text'))
    .join('\n\n');
  const wrappedExternal = state.externalContentText
    .map((t) => safeWrap(truncate(t), 'google_drive'))
    .join('\n\n');

  // LangGraph state channels use complex internal wrapper types that resolve
  // correctly under `tsc` but appear as `error` type in lint-staged's isolated
  // ESLint context. Extracting to a typed local variable is the cleanest workaround.
  const intent: string | undefined = state.intent;

  const userMessage = EXTRACTOR_USER_PROMPT_TEMPLATE({
    intent,
    wrappedEmail,
    wrappedAttachments,
    wrappedExternal,
  });

  const extractorResult = await aiModelService.generateStructured({
    schema: ExtractorSchema,
    runName: 'ExtractorNode',
    messages: [
      { role: 'system', content: EXTRACTOR_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  });

  return { extractorResult };
}
