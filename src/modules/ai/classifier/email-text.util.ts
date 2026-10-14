/**
 * Prepares raw email text for the classifier: the model must judge the NEW
 * message, not the quoted thread history, signatures, or HTML scaffolding.
 * Pure function — no Nest, no IO.
 */
const MAX_CLASSIFIER_INPUT_CHARS = 4000;

export function prepareEmailText(textPlain: string, textHtml = ''): string {
  let text = textPlain.trim().length > 0 ? textPlain : stripHtml(textHtml);
  text = text.replace(/\r\n/g, '\n');

  // Cut everything from the standard Gmail quote header downward.
  const quoteHeader = text.search(/^On .{5,200} wrote:\s*$/m);
  if (quoteHeader >= 0) text = text.slice(0, quoteHeader);

  // Drop any remaining individually-quoted lines.
  text = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n');

  // Cut at the RFC 3676 signature delimiter.
  const sig = text.search(/^--\s*$/m);
  if (sig >= 0) text = text.slice(0, sig);

  return text
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CLASSIFIER_INPUT_CHARS);
}

function stripHtml(html: string): string {
  return (
    html
      // Decode entities FIRST, then strip tags: if we stripped first, an encoded
      // `&lt;/untrusted_content&gt;` (or `&lt;system&gt;`) would survive the tag
      // regex and then decode into a live `<...>` sequence that re-introduces an
      // injection/breakout vector. Decoding first means the tag regex removes it.
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}
