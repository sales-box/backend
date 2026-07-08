import { Test, TestingModule } from '@nestjs/testing';
import { EmailsController } from './emails.controller';
import { EmailsService } from './emails.service';
import { BadRequestException } from '@nestjs/common';

describe('EmailsController', () => {
  let controller: EmailsController;

  const mockEmailsService = {
    fetchThreadsForClient: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EmailsController],
      providers: [
        {
          provide: EmailsService,
          useValue: mockEmailsService,
        },
      ],
    }).compile();

    controller = module.get<EmailsController>(EmailsController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
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
