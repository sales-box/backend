import { cleanPhone } from './phone';

describe('cleanPhone', () => {
  // The value that broke a live update on 29 Aug: Zoho answered
  // INVALID_DATA on $.data[0].Phone and discarded the company and job
  // title that were in the same record.
  it('keeps the number and drops the prose the model appended', () => {
    expect(cleanPhone('+20 122 555 0987, based in New Cairo')).toBe(
      '+20 122 555 0987',
    );
  });

  it.each([
    ['+20 100 555 0142', '+20 100 555 0142'],
    ['  +20 111 555 0303  ', '+20 111 555 0303'],
    ['(202) 555-0147', '(202) 555-0147'],
    ['020 7946 0958 ext 22', '020 7946 0958 ext 22'],
    ['+201225550987 — direct', '+201225550987'],
  ])('passes a real number through: %p', (raw, expected) => {
    expect(cleanPhone(raw)).toBe(expected);
  });

  // Omitting the field is right when there is no number: the rest of the
  // record still lands, which is the whole point.
  it.each([undefined, '', '   ', 'call the office', 'see signature', '12345'])(
    'returns undefined for %p rather than sending junk',
    (raw) => {
      expect(cleanPhone(raw)).toBeUndefined();
    },
  );

  it('never returns a value ending in punctuation', () => {
    expect(cleanPhone('+20 122 555 0987. Please use this line')).toBe(
      '+20 122 555 0987',
    );
  });
});
