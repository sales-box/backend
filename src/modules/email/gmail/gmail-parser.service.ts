import { Injectable } from '@nestjs/common';
import { ParsedMessage } from '@/modules/email/email.types';
import type { gmail_v1 } from 'googleapis';
import { DecodedGmailHistory } from './gmail.types';

@Injectable()
export class GmailParserService {
  public parseMessage(gmailApiResp: gmail_v1.Schema$Message): ParsedMessage {
    const parsedMessage: ParsedMessage =
      this.initializeParsedMessage(gmailApiResp);

    this.extractContentFromPayload(gmailApiResp.payload, parsedMessage);

    return parsedMessage;
  }

  public parsePubSubNotificationPayload(data: string): DecodedGmailHistory {
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    const jsonString = Buffer.from(base64, 'base64').toString('utf-8');
    const decodedData = JSON.parse(jsonString) as DecodedGmailHistory;
    return decodedData;
  }

  private initializeParsedMessage(
    gmailApiResp: gmail_v1.Schema$Message,
  ): ParsedMessage {
    const headersMap: Map<string, string> = this.getHeadersMap(
      gmailApiResp.payload?.headers || [],
    );

    const parsedMessage: ParsedMessage = {
      id: gmailApiResp.id || '',
      threadId: gmailApiResp.threadId || '',
      subject: headersMap.get('subject') || '',
      from: headersMap.get('from') || '',
      to: headersMap.get('to') || '',
      date: headersMap.get('date') || gmailApiResp.internalDate || '',
      textPlain: '',
      textHtml: '',
      attachments: [],
    };

    return parsedMessage;
  }

  private getHeadersMap(
    headers: gmail_v1.Schema$MessagePartHeader[],
  ): Map<string, string> {
    const headersMap = new Map<string, string>();

    headers.forEach((header) => {
      if (!header.name || !header.value) return;
      headersMap.set(header.name.toLowerCase(), header.value);
    });

    return headersMap;
  }

  private extractContentFromPayload(
    payload: gmail_v1.Schema$MessagePart | undefined,
    parsedMessage: ParsedMessage,
  ): void {
    if (!payload) return;

    const stack: gmail_v1.Schema$MessagePart[] = [payload];

    while (stack.length > 0) {
      const currentPart = stack.pop();
      if (!currentPart) continue;

      if (currentPart.parts && Array.isArray(currentPart.parts)) {
        stack.push(...currentPart.parts.reverse());
      }

      this.processBody(currentPart, parsedMessage);
    }
  }

  private processBody(
    part: gmail_v1.Schema$MessagePart,
    parsedMessage: ParsedMessage,
  ): void {
    if (!part.body) return;

    const mimeType: string = part.mimeType?.toLowerCase() || '';

    const isAttachment: boolean = !!(part.body.attachmentId && part.filename);

    if (isAttachment) {
      parsedMessage.attachments.push({
        filename: part.filename || '',
        mimeType: mimeType,
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId || '',
      });
    }

    const hasData: boolean = !!part.body.data;

    if (hasData) {
      const decodedData: string = Buffer.from(
        part.body.data || '',
        'base64url',
      ).toString('utf-8');

      if (mimeType.includes('text/plain')) {
        parsedMessage.textPlain += decodedData;
      } else if (mimeType.includes('text/html')) {
        parsedMessage.textHtml += decodedData;
      }
    }
  }
}
