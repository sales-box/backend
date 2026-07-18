import { BadRequestException } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import { DocLoader } from './doc-loader.port';

export const pdfLoader: DocLoader = {
  async load(buffer) {
    try {
      const parser = new PDFParse({ data: buffer });
      const { text } = await parser.getText();
      return { text: text ?? '', meta: {} };
    } catch {
      throw new BadRequestException('Invalid or corrupted PDF file');
    }
  },
};
