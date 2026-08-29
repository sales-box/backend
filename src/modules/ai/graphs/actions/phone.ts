/**
 * Keep the phone number and drop the prose that followed it.
 *
 * A signature reading "Direct line +20 122 555 0987. We run four sites" gets
 * summarised by the model as `"+20 122 555 0987, based in New Cairo"`. Zoho
 * rejects that with INVALID_DATA and — because the API validates per record,
 * not per field — throws away the company and job title in the same call. One
 * mangled field silently loses the whole update.
 *
 * Truncating rather than dropping keeps the number the sender actually gave.
 * A value with no recognisable number at all yields undefined, so the field is
 * omitted instead of failing the record.
 */

/**
 * Digits, spaces and the punctuation a phone number legitimately contains.
 * Anchored so it matches only a LEADING number — everything after it is the
 * prose we are trying to shed.
 */
const PHONE_PREFIX = /^[+(\d][\d\s().-]*(?:(?:ext|x|#)\.?\s*\d+)?/i;

const MIN_DIGITS = 6;

export function cleanPhone(raw?: string): string | undefined {
  if (!raw) return undefined;

  const trimmed = raw.trim();
  const [candidate] = PHONE_PREFIX.exec(trimmed) ?? [];
  if (!candidate) return undefined;

  const cleaned = candidate.trim().replace(/[\s.-]+$/, '');
  const digits = cleaned.replace(/\D/g, '').length;

  return digits >= MIN_DIGITS ? cleaned : undefined;
}
