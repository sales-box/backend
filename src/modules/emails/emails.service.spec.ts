/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { Test, TestingModule } from '@nestjs/testing';
import { EmailsService } from './emails.service';
import { google } from 'googleapis';

// ---------------------------------------------------------------------------
// Mock googleapis so no real HTTP calls are made
// ---------------------------------------------------------------------------
jest.mock('googleapis', () => {
  const mockGmail = {
    users: {
      threads: {
        list: jest.fn(),
        get: jest.fn(),
      },
    },
  };
  return {
    google: {
      auth: {
        OAuth2: jest.fn().mockImplementation(() => ({
          setCredentials: jest.fn(),
        })),
      },
      gmail: jest.fn().mockReturnValue(mockGmail),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal thread detail response for threads.get */
function makeThreadDetail(
  id: string,
  internalDate: string,
  fromHeader: string,
  subject: string,
  snippet: string,
) {
  return {
    data: {
      id,
      snippet,
      messages: [
        {
          internalDate,
          snippet,
          payload: {
            headers: [
              { name: 'Subject', value: subject },
              { name: 'From', value: fromHeader },
            ],
          },
        },
      ],
    },
  };
}

/** Build a threads.list page response */
function makeListPage(
  ids: string[],
  nextPageToken?: string,
): { data: { threads: { id: string }[]; nextPageToken?: string } } {
  const page: { threads: { id: string }[]; nextPageToken?: string } = {
    threads: ids.map((id) => ({ id })),
  };
  if (nextPageToken) page.nextPageToken = nextPageToken;
  return { data: page };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('EmailsService', () => {
  let service: EmailsService;
  let mockGmail: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EmailsService],
    }).compile();

    service = module.get<EmailsService>(EmailsService);
    mockGmail = google.gmail({ version: 'v1' });
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // =========================================================================
  // Existing baseline tests
  // =========================================================================

  describe('baseline', () => {
    const clientEmail = 'client@example.com';
    const token = 'mock-access-token';

    it('returns [] when Gmail returns no threads', async () => {
      mockGmail.users.threads.list.mockResolvedValue(
        makeListPage([], undefined),
      );

      const result = await service.fetchThreadsForClient(clientEmail, token);
      expect(result).toEqual([]);
      expect(mockGmail.users.threads.get).not.toHaveBeenCalled();
    });

    it('fetches details, formats fields, determines direction and sorts newest-first', async () => {
      mockGmail.users.threads.list.mockResolvedValue(
        makeListPage(['thread1', 'thread2'], undefined),
      );

      mockGmail.users.threads.get.mockImplementation(
        ({ id }: { id: string }) => {
          if (id === 'thread1')
            return Promise.resolve(
              makeThreadDetail(
                'thread1',
                '1688126400000', // 2023-06-30
                'Client <client@example.com>',
                'Project Update',
                'Hello from thread 1',
              ),
            );
          if (id === 'thread2')
            return Promise.resolve(
              makeThreadDetail(
                'thread2',
                '1688212800000', // 2023-07-01
                'me <user@company.com>',
                'Review',
                'Draft copy for review',
              ),
            );
          return Promise.reject(new Error('Unknown thread'));
        },
      );

      const result = await service.fetchThreadsForClient(clientEmail, token);

      expect(result).toHaveLength(2);
      // newest first
      expect(result[0]).toEqual({
        date: new Date(1688212800000).toISOString(),
        subject: 'Review',
        snippet: 'Draft copy for review',
        direction: 'outbound',
      });
      expect(result[1]).toEqual({
        date: new Date(1688126400000).toISOString(),
        subject: 'Project Update',
        snippet: 'Hello from thread 1',
        direction: 'inbound',
      });
    });

    it('returns [] when the list API call throws on the first page', async () => {
      mockGmail.users.threads.list.mockRejectedValue(
        new Error('Gmail API Error'),
      );

      const result = await service.fetchThreadsForClient(clientEmail, token);
      expect(result).toEqual([]);
    });

    it('filters out individual thread-detail failures and returns the rest', async () => {
      mockGmail.users.threads.list.mockResolvedValue(
        makeListPage(['thread1', 'thread2'], undefined),
      );

      mockGmail.users.threads.get.mockImplementation(
        ({ id }: { id: string }) => {
          if (id === 'thread1')
            return Promise.resolve({
              data: { id: 'thread1', snippet: 'OK', messages: [] },
            });
          return Promise.reject(new Error('Failed to get thread2'));
        },
      );

      const result = await service.fetchThreadsForClient(clientEmail, token);
      expect(result).toHaveLength(1);
      expect(mockGmail.users.threads.get).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Part B — Pagination acceptance criteria
  // =========================================================================

  describe('Part B — Pagination & response formatting', () => {
    const clientEmail = 'client@example.com';
    const token = 'mock-access-token';

    // -----------------------------------------------------------------------
    // AC-1  Client with 25 threads → all 25 returned (mock 2 pages)
    // -----------------------------------------------------------------------
    it('AC-1: returns all 25 threads across 2 pages (20 + 5)', async () => {
      const page1Ids = Array.from({ length: 20 }, (_, i) => `t${i + 1}`);
      const page2Ids = Array.from({ length: 5 }, (_, i) => `t${i + 21}`);

      // Page 1 has nextPageToken; page 2 does not
      mockGmail.users.threads.list
        .mockResolvedValueOnce(makeListPage(page1Ids, 'token-page-2'))
        .mockResolvedValueOnce(makeListPage(page2Ids, undefined));

      // Every threads.get returns a minimal valid thread
      mockGmail.users.threads.get.mockImplementation(({ id }: { id: string }) =>
        Promise.resolve(
          makeThreadDetail(
            id,
            '1688126400000',
            'client@example.com',
            'Subject',
            'snippet',
          ),
        ),
      );

      const result = await service.fetchThreadsForClient(clientEmail, token);

      expect(result).toHaveLength(25);
      // list was called exactly twice
      expect(mockGmail.users.threads.list).toHaveBeenCalledTimes(2);
      // get was called once per thread
      expect(mockGmail.users.threads.get).toHaveBeenCalledTimes(25);
    });

    // -----------------------------------------------------------------------
    // AC-2  Page 1 triggers fetch of page 2 via nextPageToken
    // -----------------------------------------------------------------------
    it('AC-2: page 2 is fetched using the nextPageToken returned by page 1', async () => {
      mockGmail.users.threads.list
        .mockResolvedValueOnce(makeListPage(['t1'], 'my-next-page-token'))
        .mockResolvedValueOnce(makeListPage(['t2'], undefined));

      mockGmail.users.threads.get.mockResolvedValue(
        makeThreadDetail(
          'any',
          '1688126400000',
          'client@example.com',
          'S',
          'snip',
        ),
      );

      await service.fetchThreadsForClient(clientEmail, token);

      // Second call must pass the token from the first response
      expect(mockGmail.users.threads.list).toHaveBeenNthCalledWith(2, {
        userId: 'me',
        q: clientEmail,
        pageToken: 'my-next-page-token',
        maxResults: 20,
      });
    });

    // -----------------------------------------------------------------------
    // AC-3  Last page (no nextPageToken) → stops correctly (no extra call)
    // -----------------------------------------------------------------------
    it('AC-3: stops after last page when no nextPageToken is present', async () => {
      // Single page, no nextPageToken
      mockGmail.users.threads.list.mockResolvedValueOnce(
        makeListPage(['t1', 't2'], undefined),
      );

      mockGmail.users.threads.get.mockResolvedValue(
        makeThreadDetail(
          'any',
          '1688126400000',
          'client@example.com',
          'S',
          'snip',
        ),
      );

      const result = await service.fetchThreadsForClient(clientEmail, token);

      // Loop must NOT call list a second time
      expect(mockGmail.users.threads.list).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
    });

    // -----------------------------------------------------------------------
    // AC-4  Gmail pagination error → caught, partial results or empty returned
    // -----------------------------------------------------------------------
    it('AC-4: page-2 failure returns page-1 results instead of empty array', async () => {
      const page1Ids = Array.from({ length: 5 }, (_, i) => `t${i + 1}`);

      // Page 1 succeeds and advertises a second page
      mockGmail.users.threads.list
        .mockResolvedValueOnce(makeListPage(page1Ids, 'token-page-2'))
        .mockRejectedValueOnce(new Error('Network error on page 2'));

      mockGmail.users.threads.get.mockImplementation(({ id }: { id: string }) =>
        Promise.resolve(
          makeThreadDetail(
            id,
            '1688126400000',
            'client@example.com',
            'Subject',
            'snippet',
          ),
        ),
      );

      const result = await service.fetchThreadsForClient(clientEmail, token);

      // Should NOT be empty — page 1's 5 threads must be returned
      expect(result).toHaveLength(5);
      // list was called twice: once success, once failure
      expect(mockGmail.users.threads.list).toHaveBeenCalledTimes(2);
    });

    it('AC-4 (edge): first page fails → returns empty array (nothing collected yet)', async () => {
      mockGmail.users.threads.list.mockRejectedValueOnce(
        new Error('Auth error'),
      );

      const result = await service.fetchThreadsForClient(clientEmail, token);
      expect(result).toEqual([]);
    });
  });
});
