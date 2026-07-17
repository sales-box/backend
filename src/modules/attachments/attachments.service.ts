import { Injectable, Logger } from '@nestjs/common';
import { GmailClientProvider } from '../emails/gmail-client.provider';
import { AttachmentCacheRepository } from './attachment-cache.repository';
import { LlmClientService } from '../../common/llm/llm-client.service';
import { wrapUntrustedContent } from '../../common/security/untrusted-content.wrapper';
import * as pdfParse from 'pdf-parse';
import * as mammoth from 'mammoth';
import * as ExcelJS from 'exceljs';
import JSZip from 'jszip';

//------ types -------
export type ParsedAttachment = {
  filename: string;
  type: 'pdf' | 'image' | 'docx' | 'xlsx' | 'pptx' | 'unsupported';
  text?: string;
  base64?: string;
  structured?: string;
  skipped?: boolean;
  reason?: string;
  lowQuality: boolean;
  fallbackToVision: boolean;
};
export interface AttachmentRef {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}
interface EmailRef {
  id: string;
  attachments: AttachmentRef[];
}

//------------constants-------------
const MAX_SIZE_BYTES = 10 * 1024 * 1024; //10MB
const MIN_PDF_TEXT_LENGTH = 100;
const VISION_PROMPT = 'Extract all readable text from this image.';
const MIME_DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_PPTX =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);
  constructor(
    private readonly gmailClientProvider: GmailClientProvider,
    private readonly attachmentCache: AttachmentCacheRepository,
    private readonly llm: LlmClientService,
  ) {}

  async downloadAttachment(
    accountEmail: string,
    messageId: string,
    attachmentId: string,
  ): Promise<Buffer> {
    const gmail =
      await this.gmailClientProvider.getClientForAccount(accountEmail);
    const res = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    });
    if (!res.data.data) {
      throw new Error(
        `Gmail API returned no data for attachment ${attachmentId}`,
      );
    }
    return Buffer.from(res.data.data, 'base64url');
  }

  async parsePdf(buffer: Buffer): Promise<string> {
    const parser = new pdfParse.PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  parseImage(buffer: Buffer): string {
    return buffer.toString('base64');
  }

  async parseDocx(buffer: Buffer): Promise<string> {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  async parseXlsx(buffer: Buffer): Promise<string> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheetsData: Record<string, unknown[][]> = {};
    workbook.eachSheet((worksheet) => {
      const sheetName = worksheet.name;
      const rows: unknown[][] = [];
      worksheet.eachRow((row) => {
        const values = Array.isArray(row.values) ? row.values.slice(1) : [];
        rows.push(values);
      });
      sheetsData[sheetName] = rows;
    });
    return JSON.stringify(sheetsData);
  }

  async parsePptx(buffer: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(buffer);
    const slideKeys = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort();

    const slideTexts: string[] = [];
    for (const slideKey of slideKeys) {
      const xmlContent = await zip.files[slideKey].async('string');
      const textMatches: string[] =
        xmlContent.match(/<a:t[^>]*>[^<]+<\/a:t>/g) ?? [];
      const slideText = textMatches
        .map((tag: string) => tag.replace(/<[^>]+>/g, '').trim())
        .filter(Boolean)
        .join(' ');

      const slideNumber = slideKey.match(/slide(\d+)/)?.[1] ?? '?';
      slideTexts.push(`## Slide ${slideNumber}\n${slideText}`);
    }
    return slideTexts.join('\n\n');
  }

  async parseAttachmentCached(
    accountEmail: string,
    messageId: string,
    attachment: AttachmentRef,
  ): Promise<ParsedAttachment> {
    const cached = await this.attachmentCache.get(attachment.attachmentId);
    if (cached) {
      this.logger.log(
        `Cache hit for attachment ${attachment.attachmentId} (${attachment.filename})`,
      );
      return cached;
    }

    const parsed = await this.parseAttachmentFresh(
      accountEmail,
      messageId,
      attachment,
    );
    // Only successful parses are cached — skipped/parse_error results must
    // stay retryable (a transient Gmail/parser failure is not immutable).
    if (!parsed.skipped) {
      await this.attachmentCache.set(attachment.attachmentId, parsed);
    }
    return parsed;
  }

  private async parseAttachmentFresh(
    accountEmail: string,
    messageId: string,
    attachment: AttachmentRef,
  ): Promise<ParsedAttachment> {
    if (attachment.size > MAX_SIZE_BYTES) {
      this.logger.warn(
        `Attachment ${attachment.filename} skipped : exceeds 10MB (${attachment.size} bytes)`,
      );
      return {
        filename: attachment.filename,
        type: 'unsupported',
        skipped: true,
        reason: `exceeds_size_limit`,
        lowQuality: false,
        fallbackToVision: false,
      };
    }
    const mime = attachment.mimeType.toLowerCase();
    const isPdf = mime === 'application/pdf';
    const isImage = mime.startsWith('image/');
    const isDocx = mime === MIME_DOCX;
    const isXlsx = mime === MIME_XLSX;
    const isPptx = mime === MIME_PPTX;

    if (!isPdf && !isImage && !isDocx && !isXlsx && !isPptx) {
      return {
        filename: attachment.filename,
        type: 'unsupported',
        skipped: true,
        reason: `unsupported_type`,
        lowQuality: false,
        fallbackToVision: false,
      };
    }
    try {
      const buffer = await this.downloadAttachment(
        accountEmail,
        messageId,
        attachment.attachmentId,
      );

      if (isPdf) {
        const rawText = await this.parsePdf(buffer);
        const isWeak = rawText.trim().length < MIN_PDF_TEXT_LENGTH;

        if (isWeak) {
          const screenshot = await this.screenshotFirstPage(buffer);
          const visionText = await this.llm.analyzeImage(
            screenshot,
            VISION_PROMPT,
            'image/png',
          );
          return {
            filename: attachment.filename,
            type: 'pdf',
            text: wrapUntrustedContent(visionText, 'vision_extracted'),
            skipped: false,
            lowQuality: true,
            fallbackToVision: true,
          };
        }

        return {
          filename: attachment.filename,
          type: 'pdf',
          text: wrapUntrustedContent(rawText, 'attachment_text'),
          skipped: false,
          lowQuality: false,
          fallbackToVision: false,
        };
      }

      if (isImage) {
        const base64 = this.parseImage(buffer);
        const visionText = await this.llm.analyzeImage(
          base64,
          VISION_PROMPT,
          mime,
        );
        return {
          filename: attachment.filename,
          type: 'image',
          base64,
          text: wrapUntrustedContent(visionText, 'vision_extracted'),
          skipped: false,
          lowQuality: false,
          fallbackToVision: false,
        };
      }

      if (isDocx) {
        const rawText = await this.parseDocx(buffer);
        return {
          filename: attachment.filename,
          type: 'docx',
          text: wrapUntrustedContent(rawText, 'attachment_text'),
          skipped: false,
          lowQuality: false,
          fallbackToVision: false,
        };
      }

      if (isXlsx) {
        const structured = await this.parseXlsx(buffer);
        return {
          filename: attachment.filename,
          type: 'xlsx',
          structured,
          skipped: false,
          lowQuality: false,
          fallbackToVision: false,
        };
      }

      if (isPptx) {
        const rawText = await this.parsePptx(buffer);
        return {
          filename: attachment.filename,
          type: 'pptx',
          text: wrapUntrustedContent(rawText, 'attachment_text'),
          skipped: false,
          lowQuality: false,
          fallbackToVision: false,
        };
      }

      throw new Error(`Unhandled supported MIME type reached router: ${mime}`);
    } catch (err) {
      this.logger.error(
        `Failed to parse "${attachment.filename}": ${err instanceof Error ? err.message : String(err)}`,
      );
      const type = isDocx
        ? 'docx'
        : isXlsx
          ? 'xlsx'
          : isPptx
            ? 'pptx'
            : isPdf
              ? 'pdf'
              : 'image';
      return {
        filename: attachment.filename,
        type,
        skipped: true,
        reason: 'parse_error',
        lowQuality: false,
        fallbackToVision: false,
      };
    }
  }

  private async screenshotFirstPage(pdfBuffer: Buffer): Promise<string> {
    const parser = new pdfParse.PDFParse({ data: pdfBuffer });
    try {
      const result = await parser.getScreenshot({ first: 1, scale: 2 });
      const page = result.pages[0];
      return Buffer.from(page.data).toString('base64');
    } finally {
      await parser.destroy();
    }
  }

  async parseAttachments(
    accountEmail: string,
    email: EmailRef,
  ): Promise<ParsedAttachment[]> {
    if (!email.attachments || email.attachments.length === 0) {
      return [];
    }

    const results = await Promise.allSettled(
      email.attachments.map((att) =>
        this.parseAttachmentCached(accountEmail, email.id, att),
      ),
    );

    const parsedAttachments: ParsedAttachment[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const originalAtt = email.attachments[i];

      if (result.status === 'fulfilled') {
        parsedAttachments.push(result.value);
      } else {
        this.logger.error(
          `Unexpected rejection for attachment "${originalAtt.filename}": ${result.reason}`,
        );
        parsedAttachments.push({
          filename: originalAtt.filename,
          type: 'unsupported',
          skipped: true,
          reason: 'unexpected_system_error',
          lowQuality: false,
          fallbackToVision: false,
        });
      }
    }

    return parsedAttachments;
  }
}
