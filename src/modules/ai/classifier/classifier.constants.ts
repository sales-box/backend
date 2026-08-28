import { Logger } from '@nestjs/common';

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
 * The backlog runs on its OWN queue, never the live one.
 *
 * One backfill job is up to BACKFILL_MAX_MESSAGES Gmail fetches and LLM calls
 * walked serially. On the shared queue that put every live notification behind
 * it: the classifier worker's limiter bounds how often a job STARTS, not how
 * long one runs, so a mailbox connected at 9am could delay 9:01's mail by the
 * length of the whole walk. A second queue lets the backlog be slow — which it
 * should be — without live classification being slow with it.
 */
export const BACKFILL_QUEUE = 'classifier-backfill';

const logger = new Logger('ClassifierConfig');

/**
 * Both bounds below are operator input that reaches Gmail directly — one as
 * `maxResults`, the other inside a `newer_than:Nd` query. A bare `Number()`
 * accepted '0', '-1', 'abc' and '2.5' and passed them straight through, so a
 * typo in the deployment env meant a backfill that silently found nothing (or
 * a query Gmail rejects) with no signal anywhere. Bad input falls back loudly.
 */
export function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logger.warn(
      `${name}="${raw}" is not a positive integer; falling back to ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * Bounds on that pass. A backfill is unattended work against a mailbox whose
 * size we do not control, and every message costs an LLM call, so it is capped
 * on two independent axes rather than trusted to be small.
 *
 * 90 days / 500 messages covers "last week's email", which is what a new
 * customer actually expects to see, without turning a 40,000-message inbox
 * into a five-figure bill on day one. Both are overridable per deployment.
 */
export const BACKFILL_MAX_MESSAGES = positiveIntFromEnv(
  'BACKFILL_MAX_MESSAGES',
  500,
);
export const BACKFILL_NEWER_THAN_DAYS = positiveIntFromEnv(
  'BACKFILL_NEWER_THAN_DAYS',
  90,
);

// Bumped on every prompt change so eval runs and stored rows stay comparable.
export const CLASSIFIER_PROMPT_VERSION = 'v2';
