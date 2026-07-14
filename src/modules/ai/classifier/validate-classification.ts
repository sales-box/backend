import { ClassificationResult, Intent, INTENTS } from './classifier.types';

/**
 * Trust boundary: LLM output is external data. Even with schema-enforced
 * generation, validate before anything is persisted. Throwing here fails the
 * BullMQ job, which retries — a transient bad generation self-heals.
 */
export function validateClassification(raw: unknown): ClassificationResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Classifier returned a non-object result');
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.isUrgent !== 'boolean') {
    throw new Error('Classifier result: isUrgent must be a boolean');
  }
  if (
    typeof r.intent !== 'string' ||
    !(INTENTS as readonly string[]).includes(r.intent)
  ) {
    throw new Error(`Classifier result: invalid intent "${String(r.intent)}"`);
  }
  if (
    typeof r.intentConfidence !== 'number' ||
    Number.isNaN(r.intentConfidence)
  ) {
    throw new Error('Classifier result: intentConfidence must be a number');
  }

  const urgencyReason =
    typeof r.urgencyReason === 'string' && r.urgencyReason.trim() !== ''
      ? r.urgencyReason
      : null;

  return {
    reasoning: typeof r.reasoning === 'string' ? r.reasoning : '',
    isUrgent: r.isUrgent,
    urgencyReason: r.isUrgent ? urgencyReason : null,
    intent: r.intent as Intent,
    intentConfidence: Math.min(1, Math.max(0, r.intentConfidence)),
  };
}
