import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { DocLoader } from './doc-loader.port';

export const xlsxLoader: DocLoader = {
  async load(buffer) {
    try {
      const wb = new ExcelJS.Workbook();
      // exceljs bundles an older Buffer type than @types/node 22's
      // Buffer<ArrayBufferLike>; cast to exactly the param type it expects.
      await wb.xlsx.load(
        buffer as unknown as Parameters<typeof wb.xlsx.load>[0],
      );
      const lines: string[] = [];
      wb.eachSheet((sheet) => {
        sheet.eachRow((row) => {
          const cells = (row.values as unknown[]).slice(1).map((v) => {
            if (typeof v === 'string') return v;
            if (
              typeof v === 'number' ||
              typeof v === 'boolean' ||
              typeof v === 'bigint'
            ) {
              return String(v);
            }
            if (v == null) return '';
            // Rich-text/formula/date cells are objects — stringify safely
            // instead of getting "[object Object]".
            return JSON.stringify(v) ?? '';
          });
          lines.push(cells.join(' '));
        });
      });
      return { text: lines.join('\n'), meta: {} };
    } catch {
      throw new BadRequestException('Invalid or corrupted XLSX file');
    }
  },
};
