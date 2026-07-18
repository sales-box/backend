import ExcelJS from 'exceljs';
import { xlsxLoader } from './xlsx.loader';

describe('xlsxLoader', () => {
  it('flattens cells to text', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.addRow(['Model', 'Price']);
    ws.addRow(['IG-P100', '$4,200']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const { text } = await xlsxLoader.load(buf);
    expect(text).toContain('IG-P100');
    expect(text).toContain('$4,200');
  });
});
