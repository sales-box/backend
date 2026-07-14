import { validateClassification } from './validate-classification';

const valid = {
  reasoning: 'clear pre-sale question',
  isUrgent: true,
  urgencyReason: 'deadline Friday',
  intent: 'product inquiry',
  intentConfidence: 0.87,
};

describe('validateClassification', () => {
  it('passes a valid result through unchanged', () => {
    expect(validateClassification(valid)).toEqual(valid);
  });

  it('rejects an intent outside the enum', () => {
    expect(() => validateClassification({ ...valid, intent: 'spam' })).toThrow(
      /invalid intent/,
    );
  });

  it('rejects a non-boolean isUrgent', () => {
    expect(() => validateClassification({ ...valid, isUrgent: 'yes' })).toThrow(
      /isUrgent/,
    );
  });

  it('rejects a non-numeric confidence', () => {
    expect(() =>
      validateClassification({ ...valid, intentConfidence: 'high' }),
    ).toThrow(/intentConfidence/);
  });

  it('clamps confidence into [0, 1]', () => {
    expect(
      validateClassification({ ...valid, intentConfidence: 1.4 })
        .intentConfidence,
    ).toBe(1);
    expect(
      validateClassification({ ...valid, intentConfidence: -2 })
        .intentConfidence,
    ).toBe(0);
  });

  it('nulls urgencyReason when isUrgent is false', () => {
    const r = validateClassification({
      ...valid,
      isUrgent: false,
      urgencyReason: 'leftover',
    });
    expect(r.urgencyReason).toBeNull();
  });

  it('defaults missing reasoning to empty string', () => {
    const rest: Record<string, unknown> = { ...valid };
    delete rest.reasoning;
    expect(validateClassification(rest).reasoning).toBe('');
  });

  it('rejects non-object payloads', () => {
    expect(() => validateClassification('nope')).toThrow(/non-object/);
    expect(() => validateClassification(null)).toThrow(/non-object/);
  });
});
