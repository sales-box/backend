import {
  ClassificationResult,
  ComplaintTarget,
  COMPLAINT_TARGETS,
  Intent,
  INTENTS,
} from './classifier.types';

/**
 * Trust boundary: LLM output is external data. Even with schema-enforced
 * generation, validate before anything is persisted. Throwing here fails the
 * BullMQ job, which retries — a transient bad generation self-heals.
 *
 * NOTE FOR ANYONE ADDING A FIELD: this builds a FRESH object and does not use
 * CLASSIFIER_SCHEMA. Anything you add to the Zod schema but not to the return
 * below is silently dropped — the model fills it in, and it vanishes here with
 * no error anywhere. Add it in both places.
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

  // Tolerated rather than required: these fields are newer than the rows
  // already in the database and than any prompt version still in flight.
  // A missing complaint flag means "we did not detect one", which is the
  // correct reading of an older classification — refusing the whole result
  // would fail jobs over a field that simply did not exist yet.
  const isComplaint = r.isComplaint === true;
  const claimedTarget =
    typeof r.complaintAbout === 'string' &&
    (COMPLAINT_TARGETS as readonly string[]).includes(r.complaintAbout)
      ? (r.complaintAbout as ComplaintTarget)
      : 'none';

  return {
    reasoning: typeof r.reasoning === 'string' ? r.reasoning : '',
    isUrgent: r.isUrgent,
    urgencyReason: r.isUrgent ? urgencyReason : null,
    intent: r.intent as Intent,
    intentConfidence: Math.min(1, Math.max(0, r.intentConfidence)),
    isComplaint,
    // The two fields cannot disagree. "There is a complaint, about nothing" and
    // "no complaint, about the salesperson" are both nonsense, and either one
    // would route an email to the wrong place — the second silently.
    complaintAbout: isComplaint
      ? claimedTarget === 'none'
        ? 'service'
        : claimedTarget
      : 'none',
  };
}
