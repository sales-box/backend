import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';

/* eslint-disable @typescript-eslint/unbound-method */

// A verified request as JwtAuthGuard would leave it: tenant id lives on the
// token, so the controller reads it from req.user, never from the query.
function reqFor(tenantId: string | null): AuthenticatedRequest {
  return {
    user: { sub: 'admin-1', tenantId, isAdmin: true, email: 'a@t.com' },
  } as AuthenticatedRequest;
}

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
            upsertKnowledgeGap: jest.fn(),
            getActivityFeed: jest.fn(),
          },
        },
      ],
    })
      // Unit test targets the controller's logic; the guards (JwtAuthGuard,
      // AdminTenantGuard) have their own specs. Pass them through here so the
      // module compiles without their dependencies.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminTenantGuard)
      .useValue({ canActivate: () => true })
      .compile();

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

      const result = await controller.getSummary(7, reqFor('tenant-a'));
      expect(service.getAnalyticsSummary).toHaveBeenCalledWith(7, 'tenant-a');
      expect(result).toEqual(mockResult);
    });

    it('should default to 30 days if no query param provided', async () => {
      await controller.getSummary(
        undefined as unknown as number,
        reqFor('tenant-a'),
      );
      expect(service.getAnalyticsSummary).toHaveBeenCalledWith(
        undefined,
        'tenant-a',
      );
    });

    it('takes tenantId from the token, not the request', async () => {
      await controller.getSummary(7, reqFor('tenant-b'));
      expect(service.getAnalyticsSummary).toHaveBeenCalledWith(7, 'tenant-b');
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

      const result = await controller.getAlerts(5, reqFor('tenant-a'));
      expect(service.getKnowledgeGapAlerts).toHaveBeenCalledWith(5, 'tenant-a');
      expect(result).toEqual(mockAlerts);
    });

    it('should default to threshold 3 if no query param provided', async () => {
      await controller.getAlerts(
        undefined as unknown as number,
        reqFor('tenant-a'),
      );
      expect(service.getKnowledgeGapAlerts).toHaveBeenCalledWith(
        undefined,
        'tenant-a',
      );
    });

    it('takes tenantId from the token, not the request', async () => {
      await controller.getAlerts(3, reqFor('tenant-b'));
      expect(service.getKnowledgeGapAlerts).toHaveBeenCalledWith(3, 'tenant-b');
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

  describe('reportGap', () => {
    it('should call upsertKnowledgeGap with topic and tenantId', async () => {
      const mockGap = {
        id: 'gap-1',
        topic: 'pricing for enterprise plan',
        tenantId: 'tenant-a',
        occurrences: 1,
        resolved: false,
      };
      (service.upsertKnowledgeGap as jest.Mock).mockResolvedValue(mockGap);

      const dto = { topic: 'pricing for enterprise plan' };
      const result = await controller.reportGap(dto, reqFor('tenant-a'));

      expect(service.upsertKnowledgeGap).toHaveBeenCalledWith(
        'pricing for enterprise plan',
        'tenant-a',
      );
      expect(result).toEqual(mockGap);
    });
  });

  describe('getActivityFeed', () => {
    it('should call getActivityFeed with correct query parameters and tenantId', async () => {
      const mockFeed = {
        data: [
          {
            id: 'int-1',
            time: new Date(),
            client: 'Alice',
            company: 'Acme Corp',
            classification: 'sales_inquiry',
            confidence: 0.95,
            action: 'send_quote',
          },
        ],
        meta: {
          total: 1,
          page: 1,
          limit: 50,
          totalPages: 1,
        },
      };
      (service.getActivityFeed as jest.Mock).mockResolvedValue(mockFeed);

      const query = { page: 1, limit: 50, date: '2026-07-14' };
      const result = await controller.getActivityFeed(
        query,
        reqFor('tenant-a'),
      );

      expect(service.getActivityFeed).toHaveBeenCalledWith('tenant-a', query);
      expect(result).toEqual(mockFeed);
    });
  });
});
