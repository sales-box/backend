import { DocLoader } from './doc-loader.port';
import { textLoader } from './text.loader';
import { pdfLoader } from './pdf.loader';
import { docxLoader } from './docx.loader';
import { xlsxLoader } from './xlsx.loader';
import { pptxLoader } from './pptx.loader';

const REGISTRY: Record<string, DocLoader> = {
  '.pdf': pdfLoader,
  '.txt': textLoader,
  '.md': textLoader,
  '.docx': docxLoader,
  '.xlsx': xlsxLoader,
  '.pptx': pptxLoader,
};

export const SUPPORTED_EXTENSIONS = Object.keys(REGISTRY);

export function resolveLoader(ext: string): DocLoader | null {
  return REGISTRY[ext.toLowerCase()] ?? null;
}
