import { BUILTIN_RULES, matchRule } from './rubric';

const byCat = (c: string) => BUILTIN_RULES.find((r) => r.category === c)!;

describe('BUILTIN_RULES detectors', () => {
  it('price needs a value, not just the word', () => {
    expect(matchRule(byCat('price'), 'unit price $4,200')).toBe(true);
    expect(matchRule(byCat('price'), 'we do not list prices here')).toBe(false);
  });

  // Egyptian and Gulf documents put the currency AFTER the amount. Requiring
  // the currency first meant a price list scored as having no price in it.
  it('price accepts a trailing currency code', () => {
    expect(matchRule(byCat('price'), '| 20 mm – 32 mm | 45,900 EGP |')).toBe(
      true,
    );
    expect(matchRule(byCat('price'), 'NF-DW 30 costs 94,200 EGP')).toBe(true);
    expect(matchRule(byCat('price'), 'settlement discount 1200 SAR')).toBe(
      true,
    );
    expect(matchRule(byCat('price'), 'delivered in 14 days')).toBe(false);
  });

  // A warranty policy containing no prices at all scored as though it did,
  // because the gap after "cost" ran across a blank line into a heading number.
  it('price does not read a markdown heading number as a value', () => {
    expect(
      matchRule(
        byCat('price'),
        'or any other\nconsequential cost.\n\n## 7. Returns of conforming material',
      ),
    ).toBe(false);
    // …while the same words on one line are still a price.
    expect(matchRule(byCat('price'), 'unit cost 4,200')).toBe(true);
  });

  it('lead_time ignores unrelated numbers', () => {
    expect(matchRule(byCat('lead_time'), 'delivery in 3 weeks')).toBe(true);
    expect(matchRule(byCat('lead_time'), 'founded 30 years ago')).toBe(false);
  });

  // Same class of bug as the price heading: the number after "delivery" was a
  // list marker, not a duration.
  it('lead_time requires a unit of time after the number', () => {
    expect(
      matchRule(
        byCat('lead_time'),
        '1. The invoice number and delivery note number\n2. The heat number',
      ),
    ).toBe(false);
    expect(matchRule(byCat('lead_time'), 'delivery note number 44192')).toBe(
      false,
    );
  });

  // "within 5 working days" is how every one of these documents phrases it.
  it('lead_time accepts "working days"', () => {
    expect(
      matchRule(byCat('lead_time'), 'dispatch within 3 working days'),
    ).toBe(true);
    expect(
      matchRule(byCat('lead_time'), 'delivery within 18 working days'),
    ).toBe(true);
    expect(matchRule(byCat('lead_time'), 'in stock, ships in 2 weeks')).toBe(
      true,
    );
  });
  it('technical_specs needs a number+unit', () => {
    expect(matchRule(byCat('technical_specs'), 'flow 55 m³/h')).toBe(true);
    expect(matchRule(byCat('technical_specs'), '95% efficiency')).toBe(true);
    expect(matchRule(byCat('technical_specs'), 'a fine product')).toBe(false);
  });
  it('keyword detector matches case-insensitively', () => {
    const rule = {
      key: 'custom:x',
      category: 'iso',
      asks: 'ISO?',
      weight: 1,
      example: 'Certified to ISO 9001:2015',
      source: 'custom' as const,
      detector: { type: 'keywords' as const, any: ['ISO 9001'] },
    };
    expect(matchRule(rule, 'certified to iso 9001 standard')).toBe(true);
    expect(matchRule(rule, 'no certifications')).toBe(false);
  });
});
