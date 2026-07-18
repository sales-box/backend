import JSZip from 'jszip';
import { docxLoader } from './docx.loader';

describe('docxLoader', () => {
  it('extracts text from a docx buffer', async () => {
    const zip = new JSZip();
    zip.file(
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Flow rate 55 m3/h</w:t></w:r></w:p></w:body></w:document>',
    );
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const { text } = await docxLoader.load(buf);
    expect(text).toContain('Flow rate 55 m3/h');
  });
});
