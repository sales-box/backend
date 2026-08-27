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
  let mockHistoryList: jest.Mock;
  let mockLabelsList: jest.Mock;
  let mockMessagesList: jest.Mock;

  beforeEach(async () => {
    mockMessagesGet = jest.fn().mockResolvedValue({ data: stubRawData });
    mockMessagesList = jest.fn().mockResolvedValue({ data: { messages: [] } });
    mockThreadsList = jest.fn().mockResolvedValue({ data: { threads: [] } });
    mockThreadsGet = jest.fn().mockResolvedValue({ data: {} });
    mockHistoryList = jest.fn().mockResolvedValue({ data: {} });
    mockLabelsList = jest.fn().mockResolvedValue({
      data: { labels: [{ id: 'Label_salesbox_123', name: 'salesbox' }] },
    });

    mockCreateClient = jest.fn().mockResolvedValue({
      users: {
        messages: { get: mockMessagesGet, list: mockMessagesList },
        threads: { list: mockThreadsList, get: mockThreadsGet },
        history: { list: mockHistoryList },
        labels: { list: mockLabelsList },
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
      await provider.fetchMessage('tenant-a', 'msg-1', 'account-42');

      expect(mockCreateClient).toHaveBeenCalledWith('tenant-a', 'account-42');
    });

    it('fetches the message in full format', async () => {
      await provider.fetchMessage('tenant-a', 'msg-1', 'account-1');

      expect(mockMessagesGet).toHaveBeenCalledWith({
        userId: 'me',
        id: 'msg-1',
        format: 'full',
      });
    });

    it('passes the raw API data to the parser', async () => {
      await provider.fetchMessage('tenant-a', 'msg-1', 'account-1');

      expect(mockParseMessage).toHaveBeenCalledWith(stubRawData);
    });

    it('returns the result from the parser', async () => {
      const result = await provider.fetchMessage(
        'tenant-a',
        'msg-1',
        'account-1',
      );

      expect(result).toEqual(stubMessage);
    });

    it('propagates errors from the client factory', async () => {
      mockCreateClient.mockRejectedValue(new Error('Auth failure'));

      await expect(
        provider.fetchMessage('tenant-a', 'msg-1', 'account-1'),
      ).rejects.toThrow('Auth failure');
    });

    it('propagates errors from the Gmail API', async () => {
      mockMessagesGet.mockRejectedValue(new Error('API error'));

      await expect(
        provider.fetchMessage('tenant-a', 'msg-1', 'account-1'),
      ).rejects.toThrow('API error');
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

      await provider.fetchThreads(
        'tenant-a',
        'account-1',
        'client@example.com',
      );

      expect(mockCreateClient).toHaveBeenCalledWith('tenant-a', 'account-1');
      expect(mockThreadsList).toHaveBeenCalledWith({
        userId: 'me',
        labelIds: ['Label_salesbox_123'],
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

      await provider.fetchThreads(
        'tenant-a',
        'account-1',
        'client@example.com',
      );

      expect(mockThreadsList).toHaveBeenCalledTimes(2);
      expect(mockThreadsList).toHaveBeenNthCalledWith(2, {
        userId: 'me',
        labelIds: ['Label_salesbox_123'],
        q: 'client@example.com',
        pageToken: 'page-2-token',
        maxResults: 20,
      });
      expect(mockThreadsGet).toHaveBeenCalledTimes(2);
    });

    it('returns empty list if list call fails on first page', async () => {
      mockThreadsList.mockRejectedValue(new Error('List failed'));

      const result = await provider.fetchThreads(
        'tenant-a',
        'account-1',
        'client@example.com',
      );

      expect(result).toEqual([]);
    });
  });

  describe('fetchNewMessageIds', () => {
    it('collects new INBOX message ids across pages, dedups, and returns the newest historyId', async () => {
      mockHistoryList
        .mockResolvedValueOnce({
          data: {
            history: [
              {
                messagesAdded: [
                  { message: { id: 'm1' } },
                  { message: { id: 'm2' } },
                ],
              },
              { messagesAdded: [{ message: { id: 'm2' } }] }, // duplicate
            ],
            historyId: '150',
            nextPageToken: 'p2',
          },
        })
        .mockResolvedValueOnce({
          data: {
            history: [{ messagesAdded: [{ message: { id: 'm3' } }] }],
            historyId: '160',
          },
        });

      const result = await provider.fetchNewMessageIds(
        'tenant-a',
        'se@acme.com',
        '100',
      );

      expect(result.messageIds).toEqual(['m1', 'm2', 'm3']);
      expect(result.newHistoryId).toBe('160');
      expect(mockCreateClient).toHaveBeenCalledWith('tenant-a', 'se@acme.com');
      expect(mockHistoryList).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'me',
          startHistoryId: '100',
          historyTypes: ['messageAdded', 'labelAdded'],
          labelId: 'Label_salesbox_123',
        }),
      );
      expect(mockHistoryList).toHaveBeenCalledTimes(2);
    });

    it('returns empty ids and the start baseline when history is empty', async () => {
      mockHistoryList.mockResolvedValueOnce({ data: {} });

      const result = await provider.fetchNewMessageIds(
        'tenant-a',
        'se@acme.com',
        '100',
      );

      expect(result.messageIds).toEqual([]);
      expect(result.newHistoryId).toBe('100');
    });

    it('returns empty messageIds and does NOT call history.list if salesbox label is missing', async () => {
      mockLabelsList.mockResolvedValueOnce({ data: { labels: [] } });

      const result = await provider.fetchNewMessageIds(
        'tenant-a',
        'se@acme.com',
        '100',
      );

      expect(result.messageIds).toEqual([]);
      expect(result.newHistoryId).toBe('100');
      expect(mockHistoryList).not.toHaveBeenCalled();
    });

    it('propagates Gmail errors untouched (404 handling is the caller`s job)', async () => {
      mockHistoryList.mockRejectedValue(
        Object.assign(new Error('Not Found'), { code: 404 }),
      );

      await expect(
        provider.fetchNewMessageIds('tenant-a', 'se@acme.com', '1'),
      ).rejects.toMatchObject({ code: 404 });
    });
  });

  describe('listLabelledMessageIds', () => {
    const bounds = { maxMessages: 500, newerThanDays: 90 };

    it('lists the label under both bounds and returns the ids', async () => {
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: 'm1' }, { id: 'm2' }] },
      });

      const ids = await provider.listLabelledMessageIds(
        'tenant-a',
        'se@acme.com',
        bounds,
      );

      expect(ids).toEqual(['m1', 'm2']);
      expect(mockMessagesList).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'me',
          labelIds: ['Label_salesbox_123'],
          q: 'newer_than:90d',
          maxResults: 500,
        }),
      );
    });

    it('stops at the cap rather than walking the whole mailbox', async () => {
      mockMessagesList.mockResolvedValue({
        data: {
          messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
          nextPageToken: 'p2',
        },
      });

      const ids = await provider.listLabelledMessageIds(
        'tenant-a',
        'se@acme.com',
        { maxMessages: 2, newerThanDays: 90 },
      );

      expect(ids).toEqual(['m1', 'm2']);
      expect(mockMessagesList).toHaveBeenCalledTimes(1);
    });

    // A misconfigured cap used to reach Gmail as maxResults <= 0, which the API
    // does not read as "none".
    it('lists nothing, and calls nothing, for a non-positive cap', async () => {
      const ids = await provider.listLabelledMessageIds(
        'tenant-a',
        'se@acme.com',
        { maxMessages: 0, newerThanDays: 90 },
      );

      expect(ids).toEqual([]);
      expect(mockCreateClient).not.toHaveBeenCalled();
      expect(mockMessagesList).not.toHaveBeenCalled();
    });

    // Same guard as fetchNewMessageIds: with no label id Gmail would list the
    // ENTIRE mailbox instead of the salesbox subset.
    it('returns nothing when the account has no salesbox label', async () => {
      mockLabelsList.mockResolvedValue({ data: { labels: [] } });

      const ids = await provider.listLabelledMessageIds(
        'tenant-a',
        'se@acme.com',
        bounds,
      );

      expect(ids).toEqual([]);
      expect(mockMessagesList).not.toHaveBeenCalled();
    });
  });

  describe('fetchThreads (sorting)', () => {
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

      const result = await provider.fetchThreads('tenant-a', 'account-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('thread-new');
      expect(result[1].id).toBe('thread-old');
    });
  });
});
