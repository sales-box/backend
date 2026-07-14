import { Injectable } from '@nestjs/common';
import { LlmClientService } from '@/common/llm/llm-client.service';
import { flagSuspiciousContent } from '@/common/security/prompt-injection-prefilter';
import { wrapUntrustedContent } from '@/common/security/untrusted-content.wrapper';
import {
  GenerateStructuredParams,
  LlmClientPort,
  UntrustedSource,
} from './llm-client.port';

/**
 * Binds the shared LlmClientService (Nagy, DEP-1) to the classifier's
 * LlmClientPort. `generateStructured` delegates unchanged (identical
 * signature). `wrapUntrustedContent` composes both of Nagy's security pieces:
 * the prompt-injection prefilter (layer 1 — logs/flags known attack patterns)
 * and the shared `<untrusted_content>` wrapper (layer 2 — cages the text as
 * data before it reaches the model).
 */
@Injectable()
export class ClassifierLlmClient implements LlmClientPort {
  constructor(private readonly llm: LlmClientService) {}

  generateStructured<T>(params: GenerateStructuredParams): Promise<T> {
    return this.llm.generateStructured<T>(params);
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
