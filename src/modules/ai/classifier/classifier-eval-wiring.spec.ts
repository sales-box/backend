import { ClassifierService } from './classifier.service';
import { ClassifierLlmClient } from './classifier-llm-client.adapter';

// Set BEFORE the factory is imported — importing it constructs AiModelService,
// whose constructor calls ConfigService.getOrThrow on every one of these.
//
// All SEVEN, not the handful this test happens to need: the factory imports
// ./_env, which loads backend/.env, so a partial list still passes on a
// developer machine and throws in CI where there is no .env. That is the
// failure mode this whole file exists to prevent, so it must not have it.
for (const key of [
  'PORTKEY_API_KEY',
  'PORTKEY_BASE_URL',
  'PORTKEY_CONFIG_ID',
  'LLM_MODEL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_MODEL',
]) {
  process.env[key] ??= `test-${key.toLowerCase()}`;
}

import {
  buildClassifier,
  buildClassifierLlmClient,
} from '../../../../scripts/classifier-eval/_classifier';

/**
 * Wiring guard for the eval harness.
 *
 * scripts/classifier-eval/ holds a real harness — golden datasets, encoded pass
 * targets, a confusion matrix — and it silently stopped working when the
 * production wiring moved underneath it: ClassifierLlmClient swapped
 * LlmClientService for AiModelService, and LlmClientService gained a
 * key-rotator argument. Nothing noticed, because scripts/ is outside jest's
 * rootDir. The thing that exists to catch regressions had itself regressed.
 *
 * WHAT THIS CATCHES, precisely: drift that throws when the chain is
 * CONSTRUCTED — which is exactly what happened, since LlmClientService's
 * constructor dereferences the argument it gained. Verified by reverting the
 * factory to the old wiring: this test fails, and passes again when restored.
 *
 * WHAT IT DOES NOT CATCH: type-only drift. ts-jest runs transpile-only here
 * (tsconfig sets isolatedModules), so a signature change that still runs will
 * pass this test. `tsc --noEmit -p tsconfig.json` does cover scripts/ and is
 * what catches those — worth running before a release.
 *
 * No LLM call and no network: the construction alone is the assertion.
 */
describe('classifier eval harness wiring', () => {
  it('still builds a real ClassifierService from current constructors', () => {
    expect(buildClassifier()).toBeInstanceOf(ClassifierService);
    expect(buildClassifierLlmClient()).toBeInstanceOf(ClassifierLlmClient);
  });
});
