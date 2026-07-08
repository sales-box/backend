/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { EmailsService } from './emails.service';
import { EmailService } from '@/modules/email/email.service';
import { google } from 'googleapis';
import { EmailThread } from '@/modules/email/email.types';

// Mock googleapis for profile email resolution
jest.mock('googleapis', () => {
  const mockGmail = {
    users: {
      getProfile: jest.fn().mockResolvedValue({
        data: { emailAddress: 'seller@example.com' },
      }),
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
  let mockEmailService: any;
  let mockGmail: any;

  beforeEach(async () => {
    mockEmailService = {
      fetchThreads: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailsService,
        {
          provide: EmailService,
          useValue: mockEmailService,
        },
      ],
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

    it('returns [] when EmailService returns no threads', async () => {
      mockEmailService.fetchThreads.mockResolvedValue([]);

      const result = await service.fetchThreadsForClient(clientEmail, token);
      expect(result).toEqual([]);
      expect(mockEmailService.fetchThreads).toHaveBeenCalledWith(
        'seller@example.com',
        clientEmail,
      );
    });

    it('formats fields, determines direction and sorts newest-first', async () => {
      const mockThreads: EmailThread[] = [
        {
          id: 'thread1',
          snippet: 'snippet1',
          messages: [
            {
              id: 'msg1',
              threadId: 'thread1',
              subject: 'Project Update',
              from: 'Client <client@example.com>',
              to: 'me@company.com',
              date: '2023-06-30T12:00:00.000Z',
              textPlain: 'Hello from thread 1',
              textHtml: '',
              attachments: [],
            },
          ],
        },
        {
          id: 'thread2',
          snippet: 'snippet2',
          messages: [
            {
              id: 'msg2',
              threadId: 'thread2',
              subject: 'Review',
              from: 'me <user@company.com>',
              to: 'client@example.com',
              date: '2023-07-01T12:00:00.000Z',
              textPlain: 'Draft copy for review',
              textHtml: '',
              attachments: [],
            },
          ],
        },
      ];

      mockEmailService.fetchThreads.mockResolvedValue(mockThreads);

      const result = await service.fetchThreadsForClient(clientEmail, token);

      expect(result).toHaveLength(2);
      // Newest first (thread2 has date 2023-07-01, thread1 has date 2023-06-30)
      expect(result[0]).toEqual({
        date: '2023-07-01T12:00:00.000Z',
        subject: 'Review',
        snippet: 'Draft copy for review',
        direction: 'outbound',
      });
      expect(result[1]).toEqual({
        date: '2023-06-30T12:00:00.000Z',
        subject: 'Project Update',
        snippet: 'Hello from thread 1',
        direction: 'inbound',
      });
    });

    it('returns [] when EmailService throws an error', async () => {
      mockEmailService.fetchThreads.mockRejectedValue(
        new Error('Provider failure'),
      );

      const result = await service.fetchThreadsForClient(clientEmail, token);
      expect(result).toEqual([]);
    });

    it('returns [] when Gmail profile lookup fails', async () => {
      mockGmail.users.getProfile.mockRejectedValueOnce(
        new Error('Profile API down'),
      );

      const result = await service.fetchThreadsForClient(clientEmail, token);
      expect(result).toEqual([]);
    });
  });
});
