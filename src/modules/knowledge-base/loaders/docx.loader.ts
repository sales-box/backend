import { BadRequestException } from '@nestjs/common';
import * as mammoth from 'mammoth';
import { DocLoader } from './doc-loader.port';

export const docxLoader: DocLoader = {
  async load(buffer) {
    try {
      const { value } = await mammoth.extractRawText({ buffer });
      return { text: value ?? '', meta: {} };
    } catch {
      throw new BadRequestException('Invalid or corrupted DOCX file');
    }
  },
};
