import { RubricRule, matchRule } from './rubric';
import { CoverageResult } from './quality.types';

export function evaluateCoverage(
  text: string,
  rules: RubricRule[],
): CoverageResult {
  const passed: string[] = [];
  const failed: { category: string; asks: string }[] = [];
  let passedWeight = 0;
  let totalWeight = 0;
  for (const rule of rules) {
    totalWeight += rule.weight;
    if (matchRule(rule, text)) {
      passed.push(rule.category);
      passedWeight += rule.weight;
    } else {
      failed.push({ category: rule.category, asks: rule.asks });
    }
  }
  const score =
    totalWeight === 0 ? 0 : Math.round((100 * passedWeight) / totalWeight);
  return { score, passed, failed, ruleKeys: rules.map((r) => r.key) };
}
