/**
 * Extracts a safe, log-friendly identifier from an unknown error — the error's
 * `code` or `name` only. Never returns the message, which may contain URLs,
 * tokens, or other sensitive data.
 */
export function errName(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; code?: unknown };
    if (typeof e.code === 'string' && e.code.length > 0) return e.code;
    if (typeof e.name === 'string' && e.name.length > 0) return e.name;
  }
  return 'UnknownError';
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the result. A dependency-free bounded-concurrency map.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };

  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
