import './_env';
import { ConfigService } from '@nestjs/config';
import { AiModelService } from '../../src/modules/ai/ai.model.service';
import { ClassifierLlmClient } from '../../src/modules/ai/classifier/classifier-llm-client.adapter';
import { ClassifierService } from '../../src/modules/ai/classifier/classifier.service';

/**
 * Builds the real classifier the way the application builds it.
 *
 * ONE place, on purpose. Five eval scripts each hand-wired this chain, and when
 * the production wiring moved underneath them — ClassifierLlmClient swapping
 * LlmClientService for AiModelService, LlmClientService gaining a key-rotator
 * argument — all five broke at once and stayed broken, because nothing compiles
 * them and no test runs them. The eval that was supposed to catch a regression
 * was itself the thing that had regressed.
 *
 * Outside Nest's DI container because these are standalone scripts, but the
 * chain is identical: AiModelService takes only ConfigService, and ConfigService
 * with no arguments reads straight from process.env (which `_env` has already
 * populated from backend/.env).
 */
export function buildClassifier(): ClassifierService {
  return new ClassifierService(buildClassifierLlmClient());
}

/** The adapter on its own, for scripts that want the raw structured output. */
export function buildClassifierLlmClient(): ClassifierLlmClient {
  return new ClassifierLlmClient(new AiModelService(new ConfigService()));
}
