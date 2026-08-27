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
    // Three ways a price is actually written, in the order they appear here:
    //
    //   1. currency first  — "$4,200", "EGP 45,000". The international form.
    //   2. currency last   — "45,000 EGP". The form used on every Egyptian and
    //      Gulf invoice we will ever be handed. Only the ISO codes are listed:
    //      "4,200 $" is not something anyone writes.
    //   3. the word, then a value on THE SAME LINE.
    //
    // The same-line constraint on (3) is load-bearing. `\D{0,15}` also spans
    // newlines, so in a markdown document "…consequential cost.\n\n## 7." read
    // as a price — the "7" being a heading number. Excluding \n from the gap
    // costs nothing real: a price and the word introducing it share a line.
    /(?:\$|USD|EGP|€|£|SAR|AED)\s?\d|\d[\d,.]*\s?(?:USD|EGP|SAR|AED|EUR|GBP)\b|(?:price|cost)[^\n\d]{0,15}\d/i,
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
    // A lead time is a DURATION, so the number has to be followed by a unit of
    // time. Without that requirement the old pattern read "delivery note
    // number\n2." as a lead time — the "2" being a list item — and would have
    // read "delivery note number 44192" the same way on a single line.
    //
    // "working" is allowed between the number and the unit because "within 5
    // working days" is how every one of these documents phrases it, and the
    // previous second alternative silently failed on exactly that wording.
    /(?:lead time|delivery|dispatch|in stock)[^\n\d]{0,15}\d+\s?(?:working\s+)?(?:day|week|month|hour)s?\b|\bwithin\s+\d+\s?(?:working\s+)?(?:day|week|month|hour)s?\b/i,
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
