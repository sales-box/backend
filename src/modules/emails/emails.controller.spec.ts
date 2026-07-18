import { Test, TestingModule } from '@nestjs/testing';
import { EmailsController } from './emails.controller';
import { EmailsService } from './emails.service';
import { BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

describe('EmailsController', () => {
  let controller: EmailsController;

  const mockEmailsService = {
    fetchThreadsForClient: jest.fn(),
    getInboxStatsForSe: jest.fn(),
  };

  const tenantId = 'tenant-test-123';
  const mockReq = {
    user: { tenantId, isAdmin: false, email: 'se@example.com', sub: 'acc-1' },
  } as unknown as import('../auth/jwt-auth.guard').AuthenticatedRequest;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EmailsController],
      providers: [
        {
          provide: EmailsService,
          useValue: mockEmailsService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<EmailsController>(EmailsController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getInboxStats', () => {
    it('should call EmailsService.getInboxStatsForSe with user details from JWT', async () => {
      const mockResult = {
        totalEmails: 15,
        syncedAt: '2023-07-01T12:00:00.000Z',
        urgentCount: 3,
        intentBreakdown: { demo: 2, pricing: 1 },
        reviewedBreakdown: { green: 1, yellow: 1, red: 1 },
        notYetReviewedCount: 12,
      };
      mockEmailsService.getInboxStatsForSe.mockResolvedValue(mockResult);

      const result = await controller.getInboxStats(mockReq);

      expect(result).toEqual(mockResult);
      expect(mockEmailsService.getInboxStatsForSe).toHaveBeenCalledWith(
        'se@example.com',
        tenantId,
      );
    });
  });

  describe('getThreadHistory', () => {
    const clientEmail = 'client@example.com';
    const token = 'mock-access-token';

    it('should throw BadRequestException if x-gmail-token is missing', async () => {
      await expect(
        controller.getThreadHistory({ email: clientEmail }, undefined),
      ).rejects.toThrow(
        new BadRequestException(
          'Gmail access token is required in x-gmail-token header',
        ),
      );
      expect(mockEmailsService.fetchThreadsForClient).not.toHaveBeenCalled();
    });

    it('should call EmailsService.fetchThreadsForClient with correct parameters', async () => {
      const mockResult = [
        {
          date: '2023-07-01T12:00:00.000Z',
          subject: 'Review',
          snippet: 'Draft copy',
          direction: 'outbound' as const,
        },
      ];
      mockEmailsService.fetchThreadsForClient.mockResolvedValue(mockResult);

      const result = await controller.getThreadHistory(
        { email: clientEmail },
        token,
      );

      expect(result).toEqual(mockResult);
      expect(mockEmailsService.fetchThreadsForClient).toHaveBeenCalledWith(
        clientEmail,
        token,
      );
    });
  });
});
