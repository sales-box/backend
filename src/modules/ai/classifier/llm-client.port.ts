export type UntrustedSource =
  'email_body' | 'attachment_text' | 'vision_extracted' | 'google_drive';

export interface GenerateStructuredParams {
  systemPrompt: string;
  userMessage: string;
  schema: object;
  temperature?: number;
}

/**
 * Mirrors the "LLM Foundation" contract in CONTRACTS.md verbatim, so the real
 * llm-client.service can be bound to this token without touching any consumer.
 */
export interface LlmClientPort {
  generateStructured<T>(params: GenerateStructuredParams): Promise<T>;
  wrapUntrustedContent(content: string, source: UntrustedSource): string;
}

/** DI token — bound to ClassifierLlmClient (adapter over the shared LlmClientService). */
export const LLM_CLIENT = Symbol('LLM_CLIENT');
