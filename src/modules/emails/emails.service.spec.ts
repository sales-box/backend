/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { EmailsService } from './emails.service';
import { EmailService } from '@/modules/email/email.service';
import { google } from 'googleapis';
import { EmailThread } from '@/modules/email/email.types';
import { GmailClientProvider } from './gmail-client.provider';
import { PrismaService } from '@/database/prisma.service';

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
  let mockGmailClientProvider: any;
  let mockGmailClient: any;
  let mockPrisma: any;

  beforeEach(async () => {
    mockEmailService = {
      fetchThreads: jest.fn(),
    };

    mockGmailClient = {
      users: {
        threads: {
          list: jest.fn(),
        },
      },
    };

    mockGmailClientProvider = {
      getClientForAccount: jest.fn().mockResolvedValue(mockGmailClient),
    };

    mockPrisma = {
      $queryRaw: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailsService,
        {
          provide: EmailService,
          useValue: mockEmailService,
        },
        {
          provide: GmailClientProvider,
          useValue: mockGmailClientProvider,
        },
        {
          provide: PrismaService,
          useValue: mockPrisma,
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

  describe('getInboxStatsForSe', () => {
    const seEmail = 'seller@example.com';
    const tenantId = 'tenant-123';

    it('should call getClientForAccount and aggregate inbox statistics correctly when tenantId is provided', async () => {
      mockGmailClient.users.threads.list.mockResolvedValue({
        data: {
          threads: [
            { id: 'thread-1' },
            { id: 'thread-2' },
            { id: 'thread-3' },
            { id: 'thread-4' },
          ],
        },
      });

      const mockAnalyses = [
        {
          threadId: 'thread-1',
          isUrgent: true,
          intent: 'demo',
          supervisorLabel: 'green',
          reviewedAt: new Date('2026-07-18T12:00:00Z'),
        },
        {
          threadId: 'thread-2',
          isUrgent: false,
          intent: 'pricing',
          supervisorLabel: 'yellow',
          reviewedAt: new Date('2026-07-18T13:00:00Z'),
        },
        {
          threadId: 'thread-3',
          isUrgent: false,
          intent: 'demo',
          supervisorLabel: null,
          reviewedAt: null,
        },
        {
          threadId: 'thread-5', // Inactive thread
          isUrgent: true,
          intent: 'demo',
          supervisorLabel: 'red',
          reviewedAt: new Date('2026-07-18T14:00:00Z'),
        },
      ];

      mockPrisma.$queryRaw.mockResolvedValue(mockAnalyses);

      const result = await service.getInboxStatsForSe(seEmail, tenantId);

      expect(mockGmailClientProvider.getClientForAccount).toHaveBeenCalledWith(
        seEmail,
        tenantId,
      );
      expect(mockGmailClient.users.threads.list).toHaveBeenCalledWith({
        userId: 'me',
      });
      // Check query was made to Prisma
      expect(mockPrisma.$queryRaw).toHaveBeenCalled();

      // Check results
      expect(result.totalEmails).toBe(4);
      expect(result.urgentCount).toBe(1); // thread-1 is urgent (thread-5 is inactive)
      expect(result.intentBreakdown).toEqual({
        demo: 2, // thread-1, thread-3 (thread-5 is inactive)
        pricing: 1, // thread-2
      });
      expect(result.reviewedBreakdown).toEqual({
        green: 1, // thread-1
        yellow: 1, // thread-2
        red: 0, // thread-5 is inactive
      });
      expect(result.notYetReviewedCount).toBe(2); // thread-3 (reviewedAt is null), thread-4 (no analysis record)
      expect(result.syncedAt).toBeDefined();
    });

    it('should query with tenant_id IS NULL and aggregate correctly when tenantId is not provided', async () => {
      mockGmailClient.users.threads.list.mockResolvedValue({
        data: {
          threads: [{ id: 'thread-1' }],
        },
      });

      mockPrisma.$queryRaw.mockResolvedValue([
        {
          threadId: 'thread-1',
          isUrgent: false,
          intent: 'general',
          supervisorLabel: 'red',
          reviewedAt: new Date(),
        },
      ]);

      const result = await service.getInboxStatsForSe(seEmail, undefined);

      expect(mockGmailClientProvider.getClientForAccount).toHaveBeenCalledWith(
        seEmail,
        undefined,
      );
      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
      expect(result.totalEmails).toBe(1);
      expect(result.urgentCount).toBe(0);
      expect(result.intentBreakdown).toEqual({ general: 1 });
      expect(result.reviewedBreakdown).toEqual({ green: 0, yellow: 0, red: 1 });
      expect(result.notYetReviewedCount).toBe(0);
    });

    it('should return totalEmails 0 if threads list is empty or undefined', async () => {
      mockGmailClient.users.threads.list.mockResolvedValue({
        data: {},
      });
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.getInboxStatsForSe(seEmail);

      expect(mockGmailClientProvider.getClientForAccount).toHaveBeenCalledWith(
        seEmail,
        undefined,
      );
      expect(result.totalEmails).toBe(0);
      expect(result.urgentCount).toBe(0);
      expect(result.intentBreakdown).toEqual({});
      expect(result.reviewedBreakdown).toEqual({ green: 0, yellow: 0, red: 0 });
      expect(result.notYetReviewedCount).toBe(0);
    });
  });
});
