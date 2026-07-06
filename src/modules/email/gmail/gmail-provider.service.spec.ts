/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Test, TestingModule } from '@nestjs/testing';
import { GmailProvider } from '@/modules/email/gmail/gmail-provider.service';
import { GmailClientFactory } from '@/modules/email/gmail/gmail-client.factory';
import { GmailParserService } from '@/modules/email/gmail/gmail-parser.service';
import { ParsedMessage } from '@/modules/email/email.types';

const stubMessage: ParsedMessage = {
  id: 'msg-1',
  threadId: 'thread-1',
  subject: 'Hello',
  from: 'a@example.com',
  to: 'b@example.com',
  date: '2024-01-01T12:00:00.000Z',
  textPlain: 'body',
  textHtml: '',
  attachments: [],
};

const stubRawData = { id: 'msg-1', threadId: 'thread-1' };

describe('GmailProvider', () => {
  let provider: GmailProvider;
  let mockCreateClient: jest.Mock;
  let mockParseMessage: jest.Mock;
  let mockParseThread: jest.Mock;
  let mockMessagesGet: jest.Mock;
  let mockThreadsList: jest.Mock;
  let mockThreadsGet: jest.Mock;

  beforeEach(async () => {
    mockMessagesGet = jest.fn().mockResolvedValue({ data: stubRawData });
    mockThreadsList = jest.fn().mockResolvedValue({ data: { threads: [] } });
    mockThreadsGet = jest.fn().mockResolvedValue({ data: {} });

    mockCreateClient = jest.fn().mockResolvedValue({
      users: {
        messages: { get: mockMessagesGet },
        threads: { list: mockThreadsList, get: mockThreadsGet },
      },
    });

    mockParseMessage = jest.fn().mockReturnValue(stubMessage);
    mockParseThread = jest.fn().mockReturnValue({
      id: 'thread-1',
      snippet: 'hello snippet',
      messages: [stubMessage],
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GmailProvider,
        {
          provide: GmailClientFactory,
          useValue: { createClient: mockCreateClient },
        },
        {
          provide: GmailParserService,
          useValue: {
            parseMessage: mockParseMessage,
            parseThread: mockParseThread,
          },
        },
      ],
    }).compile();

    provider = module.get<GmailProvider>(GmailProvider);
  });

  describe('fetchMessage', () => {
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

  describe('fetchThreads', () => {
    it('creates a client and fetches threads with parameters', async () => {
      mockThreadsList.mockResolvedValue({
        data: {
          threads: [{ id: 'thread-1' }],
        },
      });
      mockThreadsGet.mockResolvedValue({
        data: { id: 'thread-1', messages: [] },
      });

      await provider.fetchThreads('account-1', 'client@example.com');

      expect(mockCreateClient).toHaveBeenCalledWith('account-1');
      expect(mockThreadsList).toHaveBeenCalledWith({
        userId: 'me',
        q: 'client@example.com',
        pageToken: undefined,
        maxResults: 20,
      });
      expect(mockThreadsGet).toHaveBeenCalledWith({
        userId: 'me',
        id: 'thread-1',
      });
    });

    it('handles pagination correctly using nextPageToken', async () => {
      mockThreadsList
        .mockResolvedValueOnce({
          data: {
            threads: [{ id: 'thread-1' }],
            nextPageToken: 'page-2-token',
          },
        })
        .mockResolvedValueOnce({
          data: {
            threads: [{ id: 'thread-2' }],
          },
        });

      mockThreadsGet.mockImplementation(({ id }) => {
        return Promise.resolve({ data: { id } });
      });

      await provider.fetchThreads('account-1', 'client@example.com');

      expect(mockThreadsList).toHaveBeenCalledTimes(2);
      expect(mockThreadsList).toHaveBeenNthCalledWith(2, {
        userId: 'me',
        q: 'client@example.com',
        pageToken: 'page-2-token',
        maxResults: 20,
      });
      expect(mockThreadsGet).toHaveBeenCalledTimes(2);
    });

    it('returns empty list if list call fails on first page', async () => {
      mockThreadsList.mockRejectedValue(new Error('List failed'));

      const result = await provider.fetchThreads(
        'account-1',
        'client@example.com',
      );

      expect(result).toEqual([]);
    });

    it('returns sorted threads descending by latest message date', async () => {
      mockThreadsList.mockResolvedValue({
        data: {
          threads: [{ id: 'thread-old' }, { id: 'thread-new' }],
        },
      });

      mockThreadsGet.mockImplementation(({ id }) => {
        return Promise.resolve({ data: { id } });
      });

      // Mock parser to return threads with different dates
      mockParseThread.mockImplementation((thread) => {
        if (thread.id === 'thread-old') {
          return {
            id: 'thread-old',
            snippet: 'old',
            messages: [{ date: '2024-01-01T10:00:00.000Z' }],
          };
        }
        return {
          id: 'thread-new',
          snippet: 'new',
          messages: [{ date: '2024-01-02T10:00:00.000Z' }],
        };
      });

      const result = await provider.fetchThreads('account-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('thread-new');
      expect(result[1].id).toBe('thread-old');
    });
  });
});
