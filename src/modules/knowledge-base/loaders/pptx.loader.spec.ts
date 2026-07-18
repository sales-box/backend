import JSZip from 'jszip';
import { pptxLoader } from './pptx.loader';

describe('pptxLoader', () => {
  it('extracts <a:t> runs from slide xml', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>250 kVA generator</a:t><a:t>diesel</a:t></p:sld>',
    );
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const { text } = await pptxLoader.load(buf);
    expect(text).toContain('250 kVA generator');
    expect(text).toContain('diesel');
  });

  it('returns empty text for an image-only deck (no <a:t>)', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<p:sld/>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const { text } = await pptxLoader.load(buf);
    expect(text.trim()).toBe('');
  });
});
