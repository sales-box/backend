export const CLASSIFIER_QUEUE = 'classifier';
export const CLASSIFY_EMAIL_JOB = 'classify-email';

/**
 * One-shot pass over the mail a mailbox ALREADY held when it was connected.
 *
 * The live path (`CLASSIFY_EMAIL_JOB`) reads Gmail's history feed, which only
 * moves forward from the watch baseline. Everything older than the moment a
 * company signed up is therefore invisible to it — a customer connects, opens
 * the dashboard, and finds nothing there but whatever has arrived since. This
 * job closes that hole.
 */
export const BACKFILL_INBOX_JOB = 'backfill-inbox';

/**
 * Bounds on that pass. A backfill is unattended work against a mailbox whose
 * size we do not control, and every message costs an LLM call, so it is capped
 * on two independent axes rather than trusted to be small.
 *
 * 90 days / 500 messages covers "last week's email", which is what a new
 * customer actually expects to see, without turning a 40,000-message inbox
 * into a five-figure bill on day one. Both are overridable per deployment.
 */
export const BACKFILL_MAX_MESSAGES = Number(
  process.env.BACKFILL_MAX_MESSAGES ?? 500,
);
export const BACKFILL_NEWER_THAN_DAYS = Number(
  process.env.BACKFILL_NEWER_THAN_DAYS ?? 90,
);

// Bumped on every prompt change so eval runs and stored rows stay comparable.
export const CLASSIFIER_PROMPT_VERSION = 'v2';
