/**
 * Error shapes the classification pipeline has to tell apart, shared by the
 * live worker, the backlog worker, and the per-message step between them.
 * Which of these an error is decides whether a message is skipped, the batch
 * is deferred, or the history baseline is re-anchored — so they live in one
 * place rather than being re-derived per caller.
 */

function httpStatusOf(error: unknown): number | undefined {
  return (
    (error as { code?: number }).code ??
    (error as { response?: { status?: number } }).response?.status
  );
}

/** Gmail signals an expired/unknown startHistoryId with a 404. */
export function isHistoryExpiredError(error: unknown): boolean {
  return httpStatusOf(error) === 404;
}

/**
 * A single message that can no longer be fetched (deleted/expunged after it was
 * added to INBOX) returns 404/410. This is PERMANENT: it must be skipped, never
 * counted as a batch failure — otherwise it would freeze the history baseline
 * and wedge all future classification for the account.
 */
export function isMessageGoneError(error: unknown): boolean {
  const status = httpStatusOf(error);
  return status === 404 || status === 410;
}

/**
 * Provider rate-limit (429). LlmClientService re-wraps API errors into a plain
 * Error ("LLM Generation Error: 429 status code ..."), so the HTTP status only
 * survives in the message text — hence the regex fallback.
 */
export function isRateLimitError(error: unknown): boolean {
  if (httpStatusOf(error) === 429) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b/.test(message);
}
