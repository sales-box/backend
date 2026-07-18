import { BUILTIN_RULES, matchRule } from './rubric';

const byCat = (c: string) => BUILTIN_RULES.find((r) => r.category === c)!;

describe('BUILTIN_RULES detectors', () => {
  it('price needs a value, not just the word', () => {
    expect(matchRule(byCat('price'), 'unit price $4,200')).toBe(true);
    expect(matchRule(byCat('price'), 'we do not list prices here')).toBe(false);
  });
  it('technical_specs needs a number+unit', () => {
    expect(matchRule(byCat('technical_specs'), 'flow 55 m³/h')).toBe(true);
    expect(matchRule(byCat('technical_specs'), '95% efficiency')).toBe(true);
    expect(matchRule(byCat('technical_specs'), 'a fine product')).toBe(false);
  });
  it('lead_time ignores unrelated numbers', () => {
    expect(matchRule(byCat('lead_time'), 'delivery in 3 weeks')).toBe(true);
    expect(matchRule(byCat('lead_time'), 'founded 30 years ago')).toBe(false);
  });
  it('keyword detector matches case-insensitively', () => {
    const rule = {
      key: 'custom:x',
      category: 'iso',
      asks: 'ISO?',
      weight: 1,
      source: 'custom' as const,
      detector: { type: 'keywords' as const, any: ['ISO 9001'] },
    };
    expect(matchRule(rule, 'certified to iso 9001 standard')).toBe(true);
    expect(matchRule(rule, 'no certifications')).toBe(false);
  });
});
