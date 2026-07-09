import { GmailParserService } from '@/modules/email/gmail/gmail-parser.service';
import type { gmail_v1 } from 'googleapis';

function encode(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64url');
}

function makeHeaders(
  map: Record<string, string>,
): gmail_v1.Schema$MessagePartHeader[] {
  return Object.entries(map).map(([name, value]) => ({ name, value }));
}

const BASE_HEADERS = makeHeaders({
  subject: 'Test Subject',
  from: 'sender@example.com',
  to: 'recipient@example.com',
  date: 'Mon, 1 Jan 2024 00:00:00 +0000',
});

describe('GmailParserService', () => {
  let service: GmailParserService;

  beforeEach(() => {
    service = new GmailParserService();
  });

  it('full email → parsed object has all required fields', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-full',
      threadId: 'thread-full',
      payload: {
        headers: BASE_HEADERS,
        mimeType: 'text/plain',
        body: { data: encode('Hello') },
      },
    };

    const result = service.parseMessage(raw);

    expect(result.id).toBe('msg-full');
    expect(result.threadId).toBe('thread-full');
    expect(result.subject).toBe('Test Subject');
    expect(result.from).toBe('sender@example.com');
    expect(result.to).toBe('recipient@example.com');
    expect(result.date).toBe('Mon, 1 Jan 2024 00:00:00 +0000');
    expect(result.textPlain).toBeDefined();
    expect(result.textHtml).toBeDefined();
    expect(result.attachments).toBeDefined();
  });

  it('plain-text body is decoded from base64url', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-plain',
      threadId: 'thread-1',
      payload: {
        headers: BASE_HEADERS,
        mimeType: 'text/plain',
        body: { data: encode('Hello, World!') },
      },
    };

    const result = service.parseMessage(raw);

    expect(result.textPlain).toBe('Hello, World!');
    expect(result.textHtml).toBe('');
  });

  it('html body is decoded from base64url', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-html',
      threadId: 'thread-1',
      payload: {
        headers: BASE_HEADERS,
        mimeType: 'text/html',
        body: { data: encode('<p>Hello</p>') },
      },
    };

    const result = service.parseMessage(raw);

    expect(result.textHtml).toBe('<p>Hello</p>');
    expect(result.textPlain).toBe('');
  });

  it('multipart message populates both textPlain and textHtml', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-multi',
      threadId: 'thread-1',
      payload: {
        headers: BASE_HEADERS,
        mimeType: 'multipart/alternative',
        body: {},
        parts: [
          { mimeType: 'text/plain', body: { data: encode('plain content') } },
          {
            mimeType: 'text/html',
            body: { data: encode('<p>html content</p>') },
          },
        ],
      },
    };

    const result = service.parseMessage(raw);

    expect(result.textPlain).toBe('plain content');
    expect(result.textHtml).toBe('<p>html content</p>');
  });

  it('nested multipart parts are recursively traversed', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-nested',
      threadId: 'thread-1',
      payload: {
        headers: BASE_HEADERS,
        mimeType: 'multipart/mixed',
        body: {},
        parts: [
          {
            mimeType: 'multipart/alternative',
            body: {},
            parts: [
              {
                mimeType: 'text/plain',
                body: { data: encode('nested plain') },
              },
              {
                mimeType: 'text/html',
                body: { data: encode('<b>nested html</b>') },
              },
            ],
          },
        ],
      },
    };

    const result = service.parseMessage(raw);

    expect(result.textPlain).toBe('nested plain');
    expect(result.textHtml).toBe('<b>nested html</b>');
  });

  it('PDF attachment → MIME type recorded as application/pdf', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-pdf',
      threadId: 'thread-1',
      payload: {
        headers: BASE_HEADERS,
        mimeType: 'multipart/mixed',
        body: {},
        parts: [
          {
            mimeType: 'application/pdf',
            filename: 'report.pdf',
            body: { attachmentId: 'attach-pdf-1', size: 2048 },
          },
        ],
      },
    };

    const result = service.parseMessage(raw);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual({
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      attachmentId: 'attach-pdf-1',
    });
  });

  it('no attachments → attachments is an empty array', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-no-attach',
      threadId: 'thread-1',
      payload: {
        headers: BASE_HEADERS,
        mimeType: 'text/plain',
        body: { data: encode('no attachments here') },
      },
    };

    const result = service.parseMessage(raw);

    expect(Array.isArray(result.attachments)).toBe(true);
    expect(result.attachments).toHaveLength(0);
  });

  it('missing headers fall back to empty strings', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-no-headers',
      threadId: 'thread-1',
      payload: {
        headers: [],
        mimeType: 'text/plain',
        body: { data: encode('body') },
      },
    };

    const result = service.parseMessage(raw);

    expect(result.subject).toBe('');
    expect(result.from).toBe('');
    expect(result.to).toBe('');
    expect(result.date).toBe('');
  });

  it('malformed body → handled gracefully, no exception thrown', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-malformed',
      threadId: 'thread-1',
      payload: {
        headers: BASE_HEADERS,
        mimeType: 'text/plain',
        body: {},
      },
    };

    expect(() => service.parseMessage(raw)).not.toThrow();
  });

  it('message with no payload → returns empty parsed message without throwing', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-no-payload',
      threadId: 'thread-1',
    };

    let result: ReturnType<typeof service.parseMessage> | undefined;
    expect(() => {
      result = service.parseMessage(raw);
    }).not.toThrow();

    expect(result!.textPlain).toBe('');
    expect(result!.textHtml).toBe('');
    expect(result!.attachments).toHaveLength(0);
  });

  it('parseThread → parses a thread with messages correctly', () => {
    const rawThread: gmail_v1.Schema$Thread = {
      id: 'thread-1',
      snippet: 'Hello snippet',
      messages: [
        {
          id: 'msg-1',
          threadId: 'thread-1',
          payload: {
            headers: BASE_HEADERS,
            mimeType: 'text/plain',
            body: { data: encode('Hello') },
          },
        },
      ],
    };

    const result = service.parseThread(rawThread);

    expect(result.id).toBe('thread-1');
    expect(result.snippet).toBe('Hello snippet');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe('msg-1');
    expect(result.messages[0].subject).toBe('Test Subject');
  });
});
