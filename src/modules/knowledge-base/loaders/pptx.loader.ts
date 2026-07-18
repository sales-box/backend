import { BadRequestException } from '@nestjs/common';
import JSZip from 'jszip';
import { DocLoader } from './doc-loader.port';

export const pptxLoader: DocLoader = {
  async load(buffer) {
    try {
      const zip = await JSZip.loadAsync(buffer);
      const slideNames = Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort();
      const parts: string[] = [];
      for (const name of slideNames) {
        const xml = await zip.files[name].async('string');
        const runs = xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? [];
        for (const r of runs) {
          parts.push(r.replace(/<\/?a:t>/g, ''));
        }
      }
      return { text: parts.join('\n'), meta: {} };
    } catch {
      throw new BadRequestException('Invalid or corrupted PPTX file');
    }
  },
};
