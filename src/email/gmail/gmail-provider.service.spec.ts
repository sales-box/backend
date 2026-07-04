import { Test, TestingModule } from '@nestjs/testing';
import { GmailProvider } from '@/email/gmail/gmail-provider.service';
import { GmailClientFactory } from '@/email/gmail/gmail-client.factory';
import { GmailParserService } from '@/email/gmail/gmail-parser.service';
import { ParsedMessage } from '@/email/email.types';

const stubMessage: ParsedMessage = {
  id: 'msg-1',
  threadId: 'thread-1',
  subject: 'Hello',
  from: 'a@example.com',
  to: 'b@example.com',
  date: '2024-01-01',
  textPlain: 'body',
  textHtml: '',
  attachments: [],
};

const stubRawData = { id: 'msg-1', threadId: 'thread-1' };

describe('GmailProvider', () => {
  let provider: GmailProvider;
  let mockCreateClient: jest.Mock;
  let mockParseMessage: jest.Mock;
  let mockMessagesGet: jest.Mock;

  beforeEach(async () => {
    mockMessagesGet = jest.fn().mockResolvedValue({ data: stubRawData });
    mockCreateClient = jest.fn().mockResolvedValue({
      users: { messages: { get: mockMessagesGet } },
    });
    mockParseMessage = jest.fn().mockReturnValue(stubMessage);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GmailProvider,
        {
          provide: GmailClientFactory,
          useValue: { createClient: mockCreateClient },
        },
        {
          provide: GmailParserService,
          useValue: { parseMessage: mockParseMessage },
        },
      ],
    }).compile();

    provider = module.get<GmailProvider>(GmailProvider);
  });

  it('creates a client for the given account', async () => {
    await provider.fetchMessage('msg-1', 'account-42');

    expect(mockCreateClient).toHaveBeenCalledWith('account-42');
  });

  it('fetches the message in full format', async () => {
    await provider.fetchMessage('msg-1', 'account-1');

    expect(mockMessagesGet).toHaveBeenCalledWith({
      userId: 'me',
      id: 'msg-1',
      format: 'full',
    });
  });

  it('passes the raw API data to the parser', async () => {
    await provider.fetchMessage('msg-1', 'account-1');

    expect(mockParseMessage).toHaveBeenCalledWith(stubRawData);
  });

  it('returns the result from the parser', async () => {
    const result = await provider.fetchMessage('msg-1', 'account-1');

    expect(result).toEqual(stubMessage);
  });

  it('propagates errors from the client factory', async () => {
    mockCreateClient.mockRejectedValue(new Error('Auth failure'));

    await expect(provider.fetchMessage('msg-1', 'account-1')).rejects.toThrow(
      'Auth failure',
    );
  });

  it('propagates errors from the Gmail API', async () => {
    mockMessagesGet.mockRejectedValue(new Error('API error'));

    await expect(provider.fetchMessage('msg-1', 'account-1')).rejects.toThrow(
      'API error',
    );
  });
});
