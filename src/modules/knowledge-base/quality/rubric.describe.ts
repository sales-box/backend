import { BUILTIN_RULES, type RubricRule } from './rubric';

/**
 * Colour bands for the 0-100 coverage score.
 *
 * These lived only in the dashboard, hard-coded in two separate places, and
 * nowhere on the backend that produces the score. Publishing them from here
 * makes the number and its meaning travel together — the alternative is a
 * threshold the admin sees that nothing on the server agrees with.
 */
export const QUALITY_BANDS = { good: 80, fair: 50 } as const;

/** One rubric rule as the admin sees it — no scoring internals. */
export interface RubricCriterion {
  category: string;
  asks: string;
  example: string;
  /** Points this criterion is worth, out of 100. */
  worth: number;
}

export interface RubricDescription {
  criteria: RubricCriterion[];
  bands: { good: number; fair: number };
}

/**
 * The rubric, described for a human.
 *
 * Deliberately a projection rather than the rules themselves: `detector` holds
 * a `RegExp`, which JSON.stringify silently turns into `{}` — so shipping the
 * rules raw would put an empty object on the wire and look like it worked.
 * Publishing the patterns would also hand anyone a recipe for gaming the score
 * with text that matches and says nothing.
 *
 * `worth` is computed from the weights rather than written down, so it cannot
 * drift from the scoring: `evaluateCoverage` divides by the same total.
 */
export function describeRubric(
  rules: RubricRule[] = BUILTIN_RULES,
): RubricDescription {
  const totalWeight = rules.reduce((sum, r) => sum + r.weight, 0);
  return {
    criteria: rules.map((rule) => ({
      category: rule.category,
      asks: rule.asks,
      example: rule.example,
      worth:
        totalWeight === 0 ? 0 : Math.round((100 * rule.weight) / totalWeight),
    })),
    bands: { ...QUALITY_BANDS },
  };
}
