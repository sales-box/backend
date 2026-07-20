import { Injectable } from '@nestjs/common';
import { AiModelService } from '@/modules/ai/ai.model.service';
import { flagSuspiciousContent } from '@/common/security/prompt-injection-prefilter';
import { wrapUntrustedContent } from '@/common/security/untrusted-content.wrapper';
import {
  GenerateStructuredParams,
  LlmClientPort,
  UntrustedSource,
} from './llm-client.port';

/**
 * Binds the new AiModelService (Portkey + Langchain) to the classifier's
 * LlmClientPort. Maps the simple system/user strings into Langchain's
 * standard message array format.
 */
@Injectable()
export class ClassifierLlmClient implements LlmClientPort {
  constructor(private readonly aiModelService: AiModelService) {}

  async generateStructured<T>(params: GenerateStructuredParams): Promise<T> {
    const result = await this.aiModelService.generateStructured({
      schema: params.schema,
      runName: 'ClassifierAgent',
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userMessage },
      ],
    });

    return result as T;
  }

  wrapUntrustedContent(content: string, source: UntrustedSource): string {
    // Run the prefilter on the ORIGINAL text so a breakout attempt is logged.
    flagSuspiciousContent(content);
    // Then neutralize any literal <untrusted_content> / </untrusted_content>
    // tag inside the email so the body cannot close the cage and inject text
    // that appears OUTSIDE it. The shared wrapper does raw interpolation, so
    // this escaping is the classifier's own backstop.
    const caged = content.replace(
      /<\s*\/?\s*untrusted_content[^>]*>/gi,
      '[filtered]',
    );
    return wrapUntrustedContent(caged, source);
  }
}
