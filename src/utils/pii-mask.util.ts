/**
 * PII masking for logs.
 *
 * Free-text log messages can contain user-provided PII (emails, phone numbers,
 * national IDs, cards, IBANs). This module scrubs those out before anything is
 * written to a log, so raw PII never reaches log storage, dashboards, or error
 * trackers. See `sanitizeForLog` — the name every call site should import.
 *
 */
function maskMiddle(value: string, keepStart: number, keepEnd: number): string {
  const startPart = value.substring(0, keepStart);
  const endPart = value.substring(value.length - keepEnd);
  const middleMaskLength = value.length - keepStart - keepEnd;

  if (middleMaskLength < 1) {
    const starsOnly = '*'.repeat(Math.max(0, value.length - keepEnd));
    return starsOnly + endPart;
  }

  return startPart + '*'.repeat(middleMaskLength) + endPart;
}

/** Standard Luhn checksum — the same check banks use to validate card numbers. */
function isLuhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' === 48
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Masks the name part of an email, keeping the first letter and the domain. */
function maskEmails(text: string): string {
  const email = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  return text.replace(email, (match) => {
    const atIndex = match.indexOf('@');
    // Fixed 3 stars hides the name AND its length: ahmed@gmail.com -> a***@gmail.com
    return `${match[0]}***${match.slice(atIndex)}`;
  });
}

/** Masks the middle of an IBAN, keeping the country prefix and last 4. */
function maskIbans(text: string): string {
  // 2-letter country + 2 check digits + up to 30 alphanumerics (contiguous form).
  const iban = /\b[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,30}\b/g;
  return text.replace(iban, (match) => maskMiddle(match, 4, 4));
}

/** Masks Luhn-valid card numbers to the last 4, grouped: **** **** **** 1234 */
function maskCards(text: string): string {
  // 13–19 digits, optionally split by single spaces or dashes.
  const candidate = /\d(?:[ -]?\d){12,18}/g;
  return text.replace(candidate, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !isLuhnValid(digits)) {
      // Not a real card — leave it; the catch-all net below still masks any long run.
      return match;
    }
    const masked = '*'.repeat(digits.length - 4) + digits.slice(-4);
    // Group into blocks of 4 for readability.
    return masked.replace(/(.{4})(?=.)/g, '$1 ');
  });
}

/**
 * Catch-all net: any run of 7+ digits (phones, numeric national IDs, account
 * numbers — from any country) is masked, keeping the first 3 and last 4.
 * Must run LAST so the specific catchers above claim their text first.
 */
function maskLongNumbers(text: string): string {
  const longNumber = /\+?\d[\d\s().-]{5,}\d/g;
  return text.replace(longNumber, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 7) return match; // too short to be sensitive
    return maskMiddle(digits, 3, 4);
  });
}

/**
 * Replaces PII in free text with masked versions.
 * Order matters: specific catchers first, generic digit net last.
 */
export function sanitizeForLog(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let masked = text;
  masked = maskEmails(masked);
  masked = maskIbans(masked);
  masked = maskCards(masked);
  masked = maskLongNumbers(masked);
  return masked;
}

/** Same as sanitizeForLog. */
export const piiMask = sanitizeForLog;
