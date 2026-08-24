import { describeRubric, QUALITY_BANDS } from './rubric.describe';
import { BUILTIN_RULES } from './rubric';
import { evaluateCoverage } from './rules-evaluator';

describe('describeRubric', () => {
  it('describes every rule the scorer actually uses', () => {
    const { criteria } = describeRubric();
    expect(criteria.map((c) => c.category).sort()).toEqual(
      BUILTIN_RULES.map((r) => r.category).sort(),
    );
  });

  it('never puts the detector on the wire', () => {
    // `detector` holds a RegExp, which JSON.stringify turns into {} — shipping
    // the rules raw would send an empty object and look like it worked. It is
    // also a recipe for gaming the score with text that matches and says
    // nothing.
    const serialised = JSON.stringify(describeRubric());
    expect(serialised).not.toContain('detector');
    expect(serialised).not.toContain('pattern');
    expect(serialised).not.toContain('source');
  });

  it('gives every criterion a concrete example, not just a question', () => {
    // The scoring is regex-based and fussier than the question sounds:
    // "we publish competitive pricing" does not state a price. Without an
    // example the panel is something to agree with, not something to act on.
    for (const c of describeRubric().criteria) {
      expect(c.example.trim().length).toBeGreaterThan(0);
      expect(c.asks.trim().length).toBeGreaterThan(0);
    }
  });

  it('every published example really does satisfy its own criterion', () => {
    // The examples are advice. Advice that does not pass the scorer is worse
    // than none — the admin follows it, the score does not move, and they stop
    // trusting the panel. Checked against the real evaluator.
    for (const rule of BUILTIN_RULES) {
      const { passed } = evaluateCoverage(rule.example, BUILTIN_RULES);
      expect(passed).toContain(rule.category);
    }
  });

  it('worth is derived from the weights, so it cannot drift from the score', () => {
    const { criteria } = describeRubric();
    const byCategory = new Map(criteria.map((c) => [c.category, c.worth]));
    const total = BUILTIN_RULES.reduce((s, r) => s + r.weight, 0);

    for (const rule of BUILTIN_RULES) {
      expect(byCategory.get(rule.category)).toBe(
        Math.round((100 * rule.weight) / total),
      );
    }
  });

  it('the worths add up to the whole score, give or take rounding', () => {
    const sum = describeRubric().criteria.reduce((s, c) => s + c.worth, 0);
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(BUILTIN_RULES.length);
  });

  it('publishes the score bands the dashboard renders', () => {
    expect(describeRubric().bands).toEqual({ good: 80, fair: 50 });
    expect(QUALITY_BANDS.good).toBeGreaterThan(QUALITY_BANDS.fair);
  });

  it('handles an empty rule set without dividing by zero', () => {
    expect(describeRubric([])).toEqual({
      criteria: [],
      bands: { good: 80, fair: 50 },
    });
  });
});
