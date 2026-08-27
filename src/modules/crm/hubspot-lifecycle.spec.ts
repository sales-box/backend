import { statusFromLifecycleStage } from './hubspot-lifecycle';

describe('statusFromLifecycleStage', () => {
  it.each([
    ['subscriber', 'new_inquiry'],
    ['lead', 'new_inquiry'],
    ['marketingqualifiedlead', 'qualified'],
    ['salesqualifiedlead', 'qualified'],
    ['opportunity', 'opportunity'],
    ['customer', 'customer'],
    ['evangelist', 'customer'],
  ])('maps %s to %s', (stage, expected) => {
    expect(statusFromLifecycleStage(stage)).toBe(expected);
  });

  it('is case and whitespace insensitive', () => {
    expect(statusFromLifecycleStage('  Customer ')).toBe('customer');
  });

  it.each([undefined, null, ''])('returns undefined for %p', (stage) => {
    expect(statusFromLifecycleStage(stage)).toBeUndefined();
  });

  // A portal with custom lifecycle stages sends numeric internal IDs. Guessing
  // would knock a real customer back to new_inquiry on every reconnect, so an
  // unrecognised stage must yield nothing at all.
  it('returns undefined for a custom stage rather than guessing', () => {
    expect(statusFromLifecycleStage('81234567')).toBeUndefined();
    expect(statusFromLifecycleStage('churned')).toBeUndefined();
  });

  // Object.prototype keys must not leak through the lookup.
  it('does not resolve inherited object keys', () => {
    expect(statusFromLifecycleStage('constructor')).toBeUndefined();
    expect(statusFromLifecycleStage('toString')).toBeUndefined();
  });
});
