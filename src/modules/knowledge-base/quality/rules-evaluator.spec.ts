import { evaluateCoverage } from './rules-evaluator';
import { BUILTIN_RULES } from './rubric';

describe('evaluateCoverage', () => {
  it('scores the weighted pass ratio and lists gaps', () => {
    // price(3)+specs(3)+application(2) pass = 8; total = 3+3+2+1+1+2 = 12 → 67
    const text = 'price $4,200. flow 55 m³/h. designed for dewatering.';
    const r = evaluateCoverage(text, BUILTIN_RULES);
    expect(r.score).toBe(67);
    expect(r.passed).toEqual(
      expect.arrayContaining(['price', 'technical_specs', 'application']),
    );
    expect(r.failed.map((f) => f.category)).toEqual(
      expect.arrayContaining(['lead_time', 'payment_terms', 'warranty']),
    );
  });
  it('scores 0 for empty text', () => {
    expect(evaluateCoverage('', BUILTIN_RULES).score).toBe(0);
  });
});
