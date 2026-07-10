import { sanitizeForLog, piiMask } from './pii-mask.util';

describe('sanitizeForLog', () => {
  it('piiMask is the same function', () => {
    expect(piiMask).toBe(sanitizeForLog);
  });

  describe('emails', () => {
    it.each([
      ['ahmed@gmail.com', 'a***@gmail.com'],
      ['mohamed.ali@company.eg', 'm***@company.eg'],
    ])('masks the name but keeps the domain: %s', (input, expected) => {
      expect(sanitizeForLog(`contact ${input} now`)).toBe(
        `contact ${expected} now`,
      );
    });
  });

  describe('phone numbers (any country, via the catch-all net)', () => {
    it.each([
      ['01012345678', '010****5678'], // Egyptian mobile, 11 digits -> 4 stars
      ['+44 7911 123456', '447*****3456'], // UK, 12 digits -> 5 stars
      ['+20 100 123 4567', '201*****4567'], // international, 12 digits -> 5 stars
    ])('keeps first 3 / last 4: %s', (input, expected) => {
      expect(sanitizeForLog(`call me on ${input}`)).toBe(
        `call me on ${expected}`,
      );
    });
  });

  describe('national IDs (numeric, via the catch-all net)', () => {
    it('masks a 14-digit Egyptian national ID', () => {
      expect(sanitizeForLog('id 29801011234567')).toBe('id 298*******4567');
    });
  });

  describe('credit cards (Luhn-validated, grouped output)', () => {
    it('masks a valid card to the last 4', () => {
      expect(sanitizeForLog('card 4111 1111 1111 1111 ok')).toBe(
        'card **** **** **** 1111 ok',
      );
    });

    it('still masks a card written without spaces', () => {
      // 4242424242424242 is Luhn-valid.
      expect(sanitizeForLog('4242424242424242')).toBe('**** **** **** 4242');
    });
  });

  describe('IBAN', () => {
    it('masks the middle, keeping country prefix and last 4', () => {
      const input = 'iban EG380019000500000000263180002 end';
      const out = sanitizeForLog(input);
      expect(out.startsWith('iban EG38')).toBe(true);
      expect(out.endsWith('0002 end')).toBe(true);
      expect(out).not.toContain('0019000500000000263180');
    });
  });

  describe('safety', () => {
    it('masks a short-but-caught number instead of leaving raw digits', () => {
      // A 7-digit run: first3+last4 would leave 0 stars, so the guard must kick in.
      expect(sanitizeForLog('num 1234567')).toBe('num ***4567');
    });

    it('leaves non-PII text untouched', () => {
      expect(sanitizeForLog('meet at 3pm on floor 12')).toBe(
        'meet at 3pm on floor 12',
      );
    });

    it('handles empty / non-string input without throwing', () => {
      expect(sanitizeForLog('')).toBe('');
      // @ts-expect-error verifying runtime safety on a bad caller
      expect(sanitizeForLog(undefined)).toBeUndefined();
    });
  });
});
