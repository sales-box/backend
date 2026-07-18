import { resolveLoader, SUPPORTED_EXTENSIONS } from './loader-registry';
import { textLoader } from './text.loader';

describe('loader-registry', () => {
  it('maps .md to the text loader', () => {
    expect(resolveLoader('.md')).toBe(textLoader);
  });
  it('lists all supported extensions', () => {
    expect(SUPPORTED_EXTENSIONS).toEqual(
      expect.arrayContaining([
        '.pdf',
        '.txt',
        '.md',
        '.docx',
        '.xlsx',
        '.pptx',
      ]),
    );
  });
  it('returns null for an unknown extension', () => {
    expect(resolveLoader('.exe')).toBeNull();
  });
});
