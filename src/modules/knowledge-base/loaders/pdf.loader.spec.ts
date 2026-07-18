import { pdfLoader } from './pdf.loader';

describe('pdfLoader', () => {
  it('throws a BadRequest-style error on a corrupt buffer', async () => {
    await expect(pdfLoader.load(Buffer.from('not a pdf'))).rejects.toThrow(
      /corrupted PDF/i,
    );
  });
});
