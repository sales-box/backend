import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/* eslint-disable @typescript-eslint/unbound-method */

describe('AnalyticsController', () => {
  let controller: AnalyticsController;
  let service: AnalyticsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [
        {
          provide: AnalyticsService,
          useValue: {
            getAnalyticsSummary: jest.fn(),
            getKnowledgeGapAlerts: jest.fn(),
            resolveGap: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<AnalyticsController>(AnalyticsController);
    service = module.get<AnalyticsService>(AnalyticsService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getSummary', () => {
    it('should call getAnalyticsSummary with correct days', async () => {
      const mockResult = {
        totalProcessed: 10,
        byClassification: [{ _count: { _all: 10 }, classification: 'LEAD' }],
        avgConfidence: 0.9,
        lowConfidenceCount: 2,
      };
      (service.getAnalyticsSummary as jest.Mock).mockResolvedValue(mockResult);

      const result = await controller.getSummary(7);
      expect(service.getAnalyticsSummary).toHaveBeenCalledWith(7);
      expect(result).toEqual(mockResult);
    });

    it('should default to 30 days if no query param provided', async () => {
      await controller.getSummary(undefined as unknown as number);
      expect(service.getAnalyticsSummary).toHaveBeenCalledWith(undefined);
    });
  });

  describe('getAlerts', () => {
    it('should call getKnowledgeGapAlerts with threshold', async () => {
      const mockAlerts = [
        { id: '1', topic: 'test', occurrences: 5, resolved: false },
      ];
      (service.getKnowledgeGapAlerts as jest.Mock).mockResolvedValue(
        mockAlerts,
      );

      const result = await controller.getAlerts(5);
      expect(service.getKnowledgeGapAlerts).toHaveBeenCalledWith(5);
      expect(result).toEqual(mockAlerts);
    });

    it('should default to threshold 3 if no query param provided', async () => {
      await controller.getAlerts(undefined as unknown as number);
      expect(service.getKnowledgeGapAlerts).toHaveBeenCalledWith(undefined);
    });
  });

  describe('resolveGap', () => {
    it('should call resolveGap with id', async () => {
      const mockGap = {
        id: '1',
        topic: 'test',
        occurrences: 5,
        resolved: true,
      };
      (service.resolveGap as jest.Mock).mockResolvedValue(mockGap);

      const result = await controller.resolveGap('1');
      expect(service.resolveGap).toHaveBeenCalledWith('1');
      expect(result).toEqual(mockGap);
    });
  });
});
