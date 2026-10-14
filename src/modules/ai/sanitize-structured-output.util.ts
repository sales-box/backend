/**
 * Recursively walks a parsed structured-output value and un-escapes literal
 * double-escaped whitespace sequences that Gemini (via Portkey) intermittently
 * emits inside JSON string values:
 *
 *   `\\r\\n` → real `\r\n`  (checked first so Windows-style pairs stay intact)
 *   `\\n`   → real `\n`
 *   `\\t`   → real `\t`
 *
 * ## Root cause
 * When the model needs to put a newline inside a JSON string value it should
 * emit a single escape: `\n` (one backslash + n). Intermittently it
 * double-escapes instead: `\\n` (two chars). After JSON.parse the resulting
 * JS string contains the literal characters `\` and `n`, which render on
 * screen as `\n` rather than a real line break. This is a model-side decoding
 * quirk — fixing it in the prompts is ineffective.
 *
 * ## Placement
 * This function is called once inside `AiModelService.generateStructured()`
 * after `chain.invoke()` returns, covering ALL structured-output nodes
 * (composer, extractor, matcher, feedback) in a single place.
 *
 * Objects and arrays are walked recursively; non-string primitives pass
 * through unchanged. The function is intentionally kept import-free so it
 * can be unit-tested without the full NestJS / Langchain / Portkey module
 * graph.
 */
export function sanitizeStructuredOutput(value: unknown): unknown {
  if (typeof value === 'string') {
    return (
      value
        // Check \r\n before \n so that Windows-style sequences aren't
        // converted to a literal \r followed by a real newline.
        .replace(/\\r\\n/g, '\r\n')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStructuredOutput(item));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = sanitizeStructuredOutput(v);
    }
    return result;
  }
  return value;
}
