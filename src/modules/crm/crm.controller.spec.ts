import { Test, TestingModule } from '@nestjs/testing';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { CrmProvider } from './crm.constants';

describe('CrmController', () => {
  let controller: CrmController;

  const mockCrmService = {
    getCrmStatus: jest.fn(),
    connectCrm: jest.fn(),
  };

  const tenantId = 'tenant-123';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CrmController],
      providers: [
        {
          provide: CrmService,
          useValue: mockCrmService,
        },
      ],
    }).compile();

    controller = module.get<CrmController>(CrmController);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getCrmStatus', () => {
    it('calls crmService.getCrmStatus with tenantId', async () => {
      const mockStatus = { connected: true, provider: CrmProvider.Mock };
      mockCrmService.getCrmStatus.mockResolvedValue(mockStatus);

      const res = await controller.getCrmStatus(tenantId);

      expect(res).toEqual(mockStatus);
      expect(mockCrmService.getCrmStatus).toHaveBeenCalledWith(tenantId);
    });
  });

  describe('connectCrm', () => {
    it('calls crmService.connectCrm with tenantId and dto', async () => {
      const dto = { provider: CrmProvider.Mock, apiKey: 'test-key' };
      const expectedResult = { message: 'success', importedCount: 5 };
      mockCrmService.connectCrm.mockResolvedValue(expectedResult);

      const res = await controller.connectCrm(tenantId, dto);

      expect(res).toEqual(expectedResult);
      expect(mockCrmService.connectCrm).toHaveBeenCalledWith(tenantId, dto);
    });
  });
});
