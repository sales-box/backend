/**
 * Unit tests for sanitizeStructuredOutput()
 *
 * Acceptance check from the task spec: verify the sanitizer normalises
 * literal double-escaped whitespace sequences, and that real newlines / normal
 * strings pass through unchanged.
 */

import { sanitizeStructuredOutput } from './sanitize-structured-output.util';

describe('sanitizeStructuredOutput', () => {
  // -- string primitives -------------------------------------------------------

  it('replaces literal \\n sequences with real newlines', () => {
    const input = 'Hi Layla,\\n\\nThank you for following up.\\n\\nBest,';
    const output = sanitizeStructuredOutput(input);
    expect(output).toBe('Hi Layla,\n\nThank you for following up.\n\nBest,');
    expect(output as string).not.toContain('\\n');
  });

  it('replaces literal \\r\\n sequences with real CRLF (Windows-style)', () => {
    const input = 'Line one\\r\\nLine two\\r\\nLine three';
    const output = sanitizeStructuredOutput(input);
    expect(output).toBe('Line one\r\nLine two\r\nLine three');
    expect(output as string).not.toContain('\\r\\n');
  });

  it('replaces literal \\t sequences with real tabs', () => {
    const input = 'Column A\\tColumn B\\tColumn C';
    const output = sanitizeStructuredOutput(input);
    expect(output).toBe('Column A\tColumn B\tColumn C');
    expect(output as string).not.toContain('\\t');
  });

  it('handles a mix of \\r\\n and \\n without mangling \\r\\n into \\r + newline', () => {
    // The critical case: Windows-style \\r\\n must NOT become \r (literal) + \n.
    const input = 'First\\r\\nSecond\\nThird';
    const output = sanitizeStructuredOutput(input) as string;
    expect(output).toBe('First\r\nSecond\nThird');
    // Confirm no stray literal backslash survived.
    expect(output).not.toContain('\\');
  });

  // -- control: real newlines must pass through unchanged ----------------------

  it('does not touch strings that already contain real newlines', () => {
    const input = 'Hello\nWorld\n';
    expect(sanitizeStructuredOutput(input)).toBe('Hello\nWorld\n');
  });

  it('passes through plain strings with no escape sequences unchanged', () => {
    const input = 'Hello, World!';
    expect(sanitizeStructuredOutput(input)).toBe('Hello, World!');
  });

  it('passes through empty strings unchanged', () => {
    expect(sanitizeStructuredOutput('')).toBe('');
  });

  // -- non-string primitives ---------------------------------------------------

  it('passes through numbers unchanged', () => {
    expect(sanitizeStructuredOutput(42)).toBe(42);
    expect(sanitizeStructuredOutput(3.14)).toBe(3.14);
  });

  it('passes through booleans unchanged', () => {
    expect(sanitizeStructuredOutput(true)).toBe(true);
    expect(sanitizeStructuredOutput(false)).toBe(false);
  });

  it('passes through null unchanged', () => {
    expect(sanitizeStructuredOutput(null)).toBeNull();
  });

  // -- objects (the real use-case: structured output from the model) -----------

  it('sanitizes string values nested in an object', () => {
    const input = {
      draftText: 'Hi Layla,\\n\\nThank you.\\n\\nBest,',
      subject: 'Re: Follow-up',
      isUrgent: false,
    };
    const output = sanitizeStructuredOutput(input) as typeof input;
    expect(output.draftText).toBe('Hi Layla,\n\nThank you.\n\nBest,');
    expect(output.subject).toBe('Re: Follow-up'); // unchanged
    expect(output.isUrgent).toBe(false); // unchanged
  });

  it('sanitizes strings inside deeply nested objects', () => {
    const input = {
      composer: {
        draftText: 'Dear Sir,\\n\\nRegards.',
        claims: [{ status: 'verified', text: 'No issues.\\n' }],
      },
    };
    const output = sanitizeStructuredOutput(input) as typeof input;
    expect(output.composer.draftText).toBe('Dear Sir,\n\nRegards.');
    expect(output.composer.claims[0].text).toBe('No issues.\n');
  });

  // -- arrays ------------------------------------------------------------------

  it('sanitizes strings inside arrays', () => {
    const input = ['First\\nLine', 'Second\\nLine'];
    const output = sanitizeStructuredOutput(input) as string[];
    expect(output[0]).toBe('First\nLine');
    expect(output[1]).toBe('Second\nLine');
  });

  it('sanitizes strings in arrays of objects', () => {
    const input = [
      { claim: 'All good.\\nConfirmed.', status: 'verified' },
      { claim: 'Unverifiable.', status: 'hallucinated' },
    ];
    const output = sanitizeStructuredOutput(input) as typeof input;
    expect(output[0].claim).toBe('All good.\nConfirmed.');
    expect(output[1].claim).toBe('Unverifiable.'); // unchanged
  });
});
