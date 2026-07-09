export interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

export interface ParsedMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  textPlain: string;
  textHtml: string;
  attachments: EmailAttachment[];
}

export interface EmailThread {
  id: string;
  snippet: string;
  messages: ParsedMessage[];
}
