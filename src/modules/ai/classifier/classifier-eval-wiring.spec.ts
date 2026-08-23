import { ClassifierService } from './classifier.service';
import { ClassifierLlmClient } from './classifier-llm-client.adapter';

// Set BEFORE the factory is imported: AiModelService reads these in its
// constructor via ConfigService.getOrThrow, and the import is what builds it.
process.env.PORTKEY_API_KEY ??= 'test-key';
process.env.LLM_MODEL ??= 'test-model';
process.env.EMBEDDING_MODEL ??= 'test-embedding-model';

import {
  buildClassifier,
  buildClassifierLlmClient,
} from '../../../../scripts/classifier-eval/_classifier';

/**
 * A compile guard for the eval harness, which nothing else compiles.
 *
 * scripts/classifier-eval/ holds a real harness — golden datasets, encoded pass
 * targets, a confusion matrix — and it silently stopped working when the
 * production wiring moved underneath it: ClassifierLlmClient swapped
 * LlmClientService for AiModelService, and LlmClientService gained a
 * key-rotator argument. Nothing noticed, because scripts are outside jest's
 * rootDir and nobody runs `tsc` on the whole project by habit. The eval that
 * exists to catch regressions had itself regressed, for months.
 *
 * Importing the factory here drags it into a suite that DOES run in CI. If the
 * wiring drifts again this file stops compiling and a test fails, instead of a
 * script quietly staying broken until someone needs it.
 *
 * Nothing is executed — no LLM call, no network. The construction alone is the
 * assertion.
 */
describe('classifier eval harness wiring', () => {
  it('still builds a real ClassifierService from current constructors', () => {
    expect(buildClassifier()).toBeInstanceOf(ClassifierService);
    expect(buildClassifierLlmClient()).toBeInstanceOf(ClassifierLlmClient);
  });
});
