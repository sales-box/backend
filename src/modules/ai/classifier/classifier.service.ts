import { Inject, Injectable } from '@nestjs/common';
import {
  CLASSIFIER_SCHEMA,
  CLASSIFIER_SYSTEM_PROMPT,
  CLASSIFIER_TEMPERATURE,
} from './classifier.prompts';
import { ClassificationResult } from './classifier.types';
import { LLM_CLIENT } from './llm-client.port';
import type { LlmClientPort } from './llm-client.port';
import { validateClassification } from './validate-classification';

/**
 * Classifier agent (design doc §1). Runs ONCE per email, in the background.
 * classify() is the CONTRACTS.md surface consumed by the Extractor.
 */
@Injectable()
export class ClassifierService {
  constructor(@Inject(LLM_CLIENT) private readonly llm: LlmClientPort) {}

  async classify(emailBody: string): Promise<ClassificationResult> {
    // Prompt-injection defense (design doc §8): the body is caged as data
    // before it ever reaches a model.
    const userMessage = this.llm.wrapUntrustedContent(emailBody, 'email_body');

    const raw = await this.llm.generateStructured<unknown>({
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
      userMessage,
      schema: CLASSIFIER_SCHEMA,
      temperature: CLASSIFIER_TEMPERATURE,
    });

    return validateClassification(raw);
  }
}
