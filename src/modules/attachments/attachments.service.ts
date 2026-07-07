import { Injectable, Logger } from '@nestjs/common';
import { GmailClientProvider } from '../emails/gmail-client.provider';
import * as pdfParse from 'pdf-parse';

//------ types -------
export type ParsedAttachment = {
  filename: string;
  type: 'pdf' | 'image' | 'unsupported';
  text?: string;
  base64?: string;
  skipped?: boolean;
  reason?: string;
};
interface AttachmentRef {
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

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);
  constructor(private readonly gmailClientProvider: GmailClientProvider) {}

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

  async parseAttachment(
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
      };
    }
    const mime = attachment.mimeType.toLowerCase();
    const isPdf = mime === 'application/pdf';
    const isImage = mime.startsWith('image/');
    if (!isPdf && !isImage) {
      return {
        filename: attachment.filename,
        type: 'unsupported',
        skipped: true,
        reason: `unsupported_type`,
      };
    }
    try {
      const buffer = await this.downloadAttachment(
        accountEmail,
        messageId,
        attachment.attachmentId,
      );
      if (isPdf) {
        const text = await this.parsePdf(buffer);
        return {
          filename: attachment.filename,
          type: 'pdf',
          text,
        };
      } else {
        const base64 = this.parseImage(buffer);
        return {
          filename: attachment.filename,
          type: 'image',
          base64,
        };
      }
    } catch (err) {
      this.logger.error(
        `Failed to parse "${attachment.filename}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        filename: attachment.filename,
        type: isPdf ? 'pdf' : 'image',
        skipped: true,
        reason: 'parse_error',
      };
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
        this.parseAttachment(accountEmail, email.id, att),
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
        });
      }
    }

    return parsedAttachments;
  }
}
