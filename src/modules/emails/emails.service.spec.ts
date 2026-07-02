/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { Test, TestingModule } from '@nestjs/testing';
import { EmailsService } from './emails.service';
import { google } from 'googleapis';

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

  describe('fetchThreadsForClient', () => {
    const clientEmail = 'client@example.com';
    const token = 'mock-access-token';

    it('should return empty array if no threads found for new client', async () => {
      mockGmail.users.threads.list.mockResolvedValue({
        data: { threads: [] },
      });

      const result = await service.fetchThreadsForClient(clientEmail, token);
      expect(result).toEqual([]);
      expect(mockGmail.users.threads.list).toHaveBeenCalledWith({
        userId: 'me',
        q: clientEmail,
        pageToken: undefined,
        maxResults: 20,
      });
      expect(mockGmail.users.threads.get).not.toHaveBeenCalled();
    });

    it('should fetch thread details, format fields, determine direction and sort descending by date', async () => {
      // Setup mocked thread list response
      mockGmail.users.threads.list.mockResolvedValue({
        data: {
          threads: [{ id: 'thread1' }, { id: 'thread2' }],
        },
      });

      // Setup mock thread details. We want thread2 to be newer than thread1.
      // thread1: date 2023-06-30T12:00:00Z, from client (inbound)
      // thread2: date 2023-07-01T12:00:00Z, from me (outbound)
      mockGmail.users.threads.get.mockImplementation(({ id }) => {
        if (id === 'thread1') {
          return Promise.resolve({
            data: {
              id: 'thread1',
              snippet: 'Hello, this is thread 1 snippet',
              messages: [
                {
                  internalDate: '1688126400000', // 2023-06-30T12:00:00Z
                  payload: {
                    headers: [
                      { name: 'Subject', value: 'Project Update' },
                      { name: 'From', value: 'Client <client@example.com>' },
                    ],
                  },
                },
              ],
            },
          });
        }
        if (id === 'thread2') {
          return Promise.resolve({
            data: {
              id: 'thread2',
              snippet: 'Draft copy for review',
              messages: [
                {
                  internalDate: '1688212800000', // 2023-07-01T12:00:00Z
                  payload: {
                    headers: [
                      { name: 'Subject', value: 'Review' },
                      { name: 'From', value: 'me <user@company.com>' },
                    ],
                  },
                },
              ],
            },
          });
        }
        return Promise.reject(new Error('Unknown thread ID'));
      });

      const result = await service.fetchThreadsForClient(clientEmail, token);

      expect(result).toHaveLength(2);

      // Verify sorting descending by date (thread2 is newest, so it must be first)
      expect(result[0]).toEqual({
        date: new Date(1688212800000).toISOString(),
        subject: 'Review',
        snippet: 'Draft copy for review',
        direction: 'outbound',
      });

      expect(result[1]).toEqual({
        date: new Date(1688126400000).toISOString(),
        subject: 'Project Update',
        snippet: 'Hello, this is thread 1 snippet',
        direction: 'inbound',
      });

      expect(mockGmail.users.threads.list).toHaveBeenCalledWith({
        userId: 'me',
        q: clientEmail,
        pageToken: undefined,
        maxResults: 20,
      });
      expect(mockGmail.users.threads.get).toHaveBeenCalledTimes(2);
    });

    it('should return empty array if list threads API call fails', async () => {
      mockGmail.users.threads.list.mockRejectedValue(
        new Error('Gmail API Error'),
      );

      const result = await service.fetchThreadsForClient(clientEmail, token);
      expect(result).toEqual([]);
    });

    it('should filter out individual threads that fail to fetch details', async () => {
      mockGmail.users.threads.list.mockResolvedValue({
        data: {
          threads: [{ id: 'thread1' }, { id: 'thread2' }],
        },
      });

      mockGmail.users.threads.get.mockImplementation(({ id }) => {
        if (id === 'thread1') {
          return Promise.resolve({
            data: {
              id: 'thread1',
              snippet: 'Snippet 1',
              messages: [],
            },
          });
        }
        return Promise.reject(new Error('Failed to get thread2'));
      });

      const result = await service.fetchThreadsForClient(clientEmail, token);
      expect(result).toHaveLength(1);
      expect(mockGmail.users.threads.get).toHaveBeenCalledTimes(2);
    });
  });
});
