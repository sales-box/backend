export type Detector =
  { type: 'regex'; pattern: RegExp } | { type: 'keywords'; any: string[] };

export interface RubricRule {
  key: string;
  category: string;
  asks: string;
  weight: number;
  detector: Detector;
  source: 'builtin' | 'custom';
  /**
   * A line that would satisfy this rule.
   *
   * The scoring is regex-based and therefore fussier than the question makes
   * it sound — "we publish competitive pricing" does not state a price, and
   * "fast delivery" is not a lead time. Showing the admin what a passing line
   * actually looks like is the difference between a criteria list they can
   * act on and one they can only agree with.
   */
  example: string;
}

const b = (
  category: string,
  weight: number,
  asks: string,
  pattern: RegExp,
  example: string,
): RubricRule => ({
  key: `builtin:${category}`,
  category,
  weight,
  asks,
  example,
  source: 'builtin',
  detector: { type: 'regex', pattern },
});

export const BUILTIN_RULES: RubricRule[] = [
  b(
    'price',
    3,
    'Does the document state a price?',
    /(?:\$|USD|EGP|€|£|SAR|AED)\s?\d|(?:price|cost)\D{0,15}\d/i,
    'Price: 45,000 EGP per unit (ex-VAT)',
  ),
  b(
    'technical_specs',
    3,
    'Does it list technical specs?',
    /\d+\s?(?:m³\/h|kW|kVA|CFM|bar|L\/min|rpm|mm|cm|kg|hp|V|Hz)\b|\d+\s?%/i,
    'Flow rate: 120 m³/h · Motor: 7.5 kW · Efficiency: 92%',
  ),
  b(
    'lead_time',
    2,
    'Does it state a lead time?',
    /(?:lead time|delivery|dispatch|in stock)\D{0,15}\d|\bwithin\s+\d+\s?(?:day|week|month)s?\b/i,
    'Lead time: delivery within 14 working days',
  ),
  b(
    'payment_terms',
    1,
    'Does it state payment terms?',
    /\bnet\s?\d+\b|\b\d+%\s?(?:deposit|advance)\b|installment/i,
    '50% advance, balance net 30 on delivery',
  ),
  b(
    'warranty',
    1,
    'Does it mention warranty?',
    /\bwarranty\b|\bguarantee\b/i,
    'Warranty: 24 months against manufacturing defects',
  ),
  b(
    'application',
    2,
    'Does it describe applications?',
    /\bsuitable for\b|\bdesigned for\b|\bideal for\b|\bused (?:in|for)\b/i,
    'Designed for industrial dewatering; suitable for construction sites',
  ),
];

/** Reserved category names — custom rules may not reuse these (spec §5.1). */
export const RESERVED_CATEGORIES = new Set(
  BUILTIN_RULES.map((r) => r.category),
);

export function matchRule(rule: RubricRule, text: string): boolean {
  if (rule.detector.type === 'regex') return rule.detector.pattern.test(text);
  const lower = text.toLowerCase();
  return rule.detector.any.some((k) => lower.includes(k.toLowerCase()));
}
