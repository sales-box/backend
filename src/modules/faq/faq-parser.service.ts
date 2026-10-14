import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { extname } from 'node:path';

export interface FaqPair {
  question: string;
  answer: string;
}

/**
 * Parses structured FAQ files into Q&A pairs.
 *
 * Supported formats:
 *   - Markdown (.md): sections delimited by ## Q: / ## A: or Q: / A: prefixes.
 *   - CSV (.csv):     two columns, optional header row "question,answer".
 *   - XLSX (.xlsx):   first two columns, optional header row.
 *
 * Parsing is intentionally lenient: blank lines between sections are ignored,
 * trailing whitespace is stripped. An empty file (or one with no parseable
 * pairs) produces an empty array — the caller decides whether that is an error.
 */
@Injectable()
export class FaqParserService {
  private readonly logger = new Logger(FaqParserService.name);

  async parse(filename: string, buffer: Buffer): Promise<FaqPair[]> {
    const ext = extname(filename).toLowerCase();

    switch (ext) {
      case '.md':
        return this.parseMarkdown(buffer.toString('utf-8'));
      case '.csv':
        return this.parseCsv(buffer.toString('utf-8'));
      case '.xlsx':
        return this.parseXlsx(buffer);
      default:
        throw new BadRequestException(
          `Unsupported FAQ file type "${ext}". Allowed: .md, .csv, .xlsx`,
        );
    }
  }

  /**
   * Markdown format — two patterns accepted:
   *
   * Pattern A (heading-based):
   *   ## Q: What are your payment terms?
   *   We offer Net-30 invoicing.
   *
   * Pattern B (prefix-based, no heading):
   *   Q: Do you have a free trial?
   *   A: Yes, 14 days.
   *
   * Both patterns can coexist in the same file.
   */
  private parseMarkdown(text: string): FaqPair[] {
    const pairs: FaqPair[] = [];
    const lines = text.split('\n');

    let currentQuestion: string | null = null;
    let answerLines: string[] = [];

    const flush = () => {
      if (currentQuestion && answerLines.length > 0) {
        const answer = answerLines.join('\n').trim();
        if (answer) pairs.push({ question: currentQuestion, answer });
      }
      currentQuestion = null;
      answerLines = [];
    };

    for (const raw of lines) {
      const line = raw.trimEnd();

      // Heading-based: ## Q: ...  or  # Q: ...
      const headingQ = line.match(/^#{1,3}\s*Q:\s*(.+)/i);
      if (headingQ) {
        flush();
        currentQuestion = headingQ[1].trim();
        continue;
      }

      // Heading-based answer line: ## A: ...
      const headingA = line.match(/^#{1,3}\s*A:\s*(.*)/i);
      if (headingA && currentQuestion) {
        answerLines.push(headingA[1].trim());
        continue;
      }

      // Prefix-based: Q: ...
      const prefixQ = line.match(/^Q:\s*(.+)/i);
      if (prefixQ) {
        flush();
        currentQuestion = prefixQ[1].trim();
        continue;
      }

      // Prefix-based: A: ...
      const prefixA = line.match(/^A:\s*(.*)/i);
      if (prefixA && currentQuestion) {
        answerLines.push(prefixA[1].trim());
        continue;
      }

      // Continuation of current answer (non-empty, non-heading line)
      if (currentQuestion && line.trim()) {
        answerLines.push(line.trim());
      }
    }
    flush();

    this.logger.log(`Parsed ${pairs.length} FAQ pairs from Markdown`);
    return pairs;
  }

  /**
   * CSV format: two columns, comma-separated.
   * Header row is optional — if the first row has "question" in column 0
   * (case-insensitive), it is skipped.
   *
   * Quoted fields (RFC 4180) are handled by splitting on the first unquoted
   * comma per line — simple but sufficient for the expected content.
   */
  private parseCsv(text: string): FaqPair[] {
    const pairs: FaqPair[] = [];
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    let skipFirst = false;
    if (lines.length > 0) {
      const firstCol = this.splitCsvLine(lines[0])[0].toLowerCase().trim();
      if (firstCol === 'question' || firstCol === 'q') skipFirst = true;
    }

    for (let i = skipFirst ? 1 : 0; i < lines.length; i++) {
      const parts = this.splitCsvLine(lines[i]);
      const question = (parts[0] ?? '').trim();
      const answer = (parts[1] ?? '').trim();
      if (question && answer) pairs.push({ question, answer });
    }

    this.logger.log(`Parsed ${pairs.length} FAQ pairs from CSV`);
    return pairs;
  }

  /**
   * Splits a single CSV line on the first unquoted comma.
   * Handles quoted fields containing commas or newlines.
   */
  private splitCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  }

  /**
   * XLSX format: reads the first worksheet, columns A (question) and B (answer).
   * A header row is skipped if column A contains "question" (case-insensitive).
   */
  private async parseXlsx(buffer: Buffer): Promise<FaqPair[]> {
    const pairs: FaqPair[] = [];

    try {
      const workbook = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await workbook.xlsx.load(buffer as any);
      const sheet = workbook.worksheets[0];
      if (!sheet) return pairs;

      let skipHeader = false;
      sheet.eachRow((row, rowNum) => {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const colA = String(row.getCell(1).value ?? '').trim();
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const colB = String(row.getCell(2).value ?? '').trim();

        // Auto-detect header row on the first pass
        if (rowNum === 1 && colA.toLowerCase() === 'question') {
          skipHeader = true;
          return;
        }
        if (skipHeader && rowNum === 1) return;

        if (colA && colB) {
          pairs.push({ question: colA, answer: colB });
        }
      });
    } catch {
      throw new BadRequestException('Invalid or corrupted XLSX file');
    }

    this.logger.log(`Parsed ${pairs.length} FAQ pairs from XLSX`);
    return pairs;
  }
}
