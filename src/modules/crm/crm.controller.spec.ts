import { Test, TestingModule } from '@nestjs/testing';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { CrmProvider } from './crm.constants';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';

describe('CrmController', () => {
  let controller: CrmController;

  const mockCrmService = {
    getCrmStatus: jest.fn(),
    connectCrm: jest.fn(),
  };

  const tenantId = 'tenant-123';

  /** Minimal AuthenticatedRequest stub that satisfies the controller methods. */
  const mockReq = {
    user: { tenantId, isAdmin: true, email: 'admin@example.com', sub: 'acc-1' },
  } as unknown as import('../auth/jwt-auth.guard').AuthenticatedRequest;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CrmController],
      providers: [
        {
          provide: CrmService,
          useValue: mockCrmService,
        },
      ],
    })
      // Guard logic is tested separately; skip here to keep unit tests fast.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminTenantGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<CrmController>(CrmController);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getCrmStatus', () => {
    it('calls crmService.getCrmStatus with tenantId from JWT', async () => {
      const mockStatus = { connected: true, provider: CrmProvider.Mock };
      mockCrmService.getCrmStatus.mockResolvedValue(mockStatus);

      const res = await controller.getCrmStatus(mockReq);

      expect(res).toEqual(mockStatus);
      expect(mockCrmService.getCrmStatus).toHaveBeenCalledWith(tenantId);
    });
  });

  describe('connectCrm', () => {
    it('calls crmService.connectCrm with tenantId from JWT and dto', async () => {
      const dto = { provider: CrmProvider.Mock, apiKey: 'test-key' };
      const expectedResult = { message: 'success', importedCount: 5 };
      mockCrmService.connectCrm.mockResolvedValue(expectedResult);

      const res = await controller.connectCrm(mockReq, dto);

      expect(res).toEqual(expectedResult);
      expect(mockCrmService.connectCrm).toHaveBeenCalledWith(tenantId, dto);
    });
  });
});
