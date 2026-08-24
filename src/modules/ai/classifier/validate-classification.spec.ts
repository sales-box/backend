import { validateClassification } from './validate-classification';

const valid = {
  reasoning: 'clear pre-sale question',
  isUrgent: true,
  urgencyReason: 'deadline Friday',
  intent: 'product inquiry',
  intentConfidence: 0.87,
  isComplaint: false,
  complaintAbout: 'none',
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

  describe('complaint fields', () => {
    it('defaults a result that predates them to "no complaint"', () => {
      // Rows classified before the flag existed, and any prompt version still
      // in flight, simply do not carry it. Refusing the whole result would
      // fail jobs over a field that did not exist yet.
      const older: Record<string, unknown> = { ...valid };
      delete older.isComplaint;
      delete older.complaintAbout;
      const out = validateClassification(older);
      expect(out).toMatchObject({ isComplaint: false, complaintAbout: 'none' });
    });

    it('keeps a real complaint and its target', () => {
      expect(
        validateClassification({
          ...valid,
          isComplaint: true,
          complaintAbout: 'person',
        }),
      ).toMatchObject({ isComplaint: true, complaintAbout: 'person' });
    });

    it('never reports a target when there is no complaint', () => {
      // "No complaint, about the salesperson" would route an email to the
      // admin's escalation feed over nothing.
      expect(
        validateClassification({
          ...valid,
          isComplaint: false,
          complaintAbout: 'person',
        }),
      ).toMatchObject({ complaintAbout: 'none' });
    });

    it('never reports a complaint about nothing', () => {
      // The mirror image: a complaint the router cannot place would be
      // silently dropped by every branch that switches on the target.
      expect(
        validateClassification({
          ...valid,
          isComplaint: true,
          complaintAbout: 'none',
        }),
      ).toMatchObject({ isComplaint: true, complaintAbout: 'service' });
    });

    it('falls back rather than trusting an unknown target', () => {
      expect(
        validateClassification({
          ...valid,
          isComplaint: true,
          complaintAbout: 'the weather',
        }),
      ).toMatchObject({ complaintAbout: 'service' });
    });
  });
});
