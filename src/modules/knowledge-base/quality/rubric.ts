export type Detector =
  { type: 'regex'; pattern: RegExp } | { type: 'keywords'; any: string[] };

export interface RubricRule {
  key: string;
  category: string;
  asks: string;
  weight: number;
  detector: Detector;
  source: 'builtin' | 'custom';
}

const b = (
  category: string,
  weight: number,
  asks: string,
  pattern: RegExp,
): RubricRule => ({
  key: `builtin:${category}`,
  category,
  weight,
  asks,
  source: 'builtin',
  detector: { type: 'regex', pattern },
});

export const BUILTIN_RULES: RubricRule[] = [
  b(
    'price',
    3,
    'Does the document state a price?',
    /(?:\$|USD|EGP|€|£|SAR|AED)\s?\d|(?:price|cost)\D{0,15}\d/i,
  ),
  b(
    'technical_specs',
    3,
    'Does it list technical specs?',
    /\d+\s?(?:m³\/h|kW|kVA|CFM|bar|L\/min|rpm|mm|cm|kg|hp|V|Hz)\b|\d+\s?%/i,
  ),
  b(
    'lead_time',
    2,
    'Does it state a lead time?',
    /(?:lead time|delivery|dispatch|in stock)\D{0,15}\d|\bwithin\s+\d+\s?(?:day|week|month)s?\b/i,
  ),
  b(
    'payment_terms',
    1,
    'Does it state payment terms?',
    /\bnet\s?\d+\b|\b\d+%\s?(?:deposit|advance)\b|installment/i,
  ),
  b('warranty', 1, 'Does it mention warranty?', /\bwarranty\b|\bguarantee\b/i),
  b(
    'application',
    2,
    'Does it describe applications?',
    /\bsuitable for\b|\bdesigned for\b|\bideal for\b|\bused (?:in|for)\b/i,
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
