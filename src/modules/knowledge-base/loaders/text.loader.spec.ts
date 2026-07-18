import { textLoader } from './text.loader';

describe('textLoader', () => {
  it('decodes a utf-8 buffer to text', async () => {
    const { text } = await textLoader.load(
      Buffer.from('hello — café', 'utf-8'),
    );
    expect(text).toBe('hello — café');
  });
});
