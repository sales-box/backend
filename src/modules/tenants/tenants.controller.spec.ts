/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

// Mock UUID to fix the Jest ESM SyntaxError during import resolution
jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mocked-uuid-token'),
}));

describe('TenantsController', () => {
  let controller: TenantsController;
  let service: TenantsService;

  const mockTenantsService = {
    signup: jest.fn(),
    verify: jest.fn(),
    getTenant: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TenantsController],
      providers: [
        {
          provide: TenantsService,
          useValue: mockTenantsService,
        },
      ],
    }).compile();

    controller = module.get<TenantsController>(TenantsController);
    service = module.get<TenantsService>(TenantsService);
    jest.clearAllMocks();
  });

  describe('signup', () => {
    it('should call tenantsService.signup', async () => {
      const dto = { companyName: 'Acme', adminEmail: 'admin@acme.com' };
      mockTenantsService.signup.mockResolvedValue({ message: 'Success' });

      const result = await controller.signup(dto);
      expect(service.signup).toHaveBeenCalledWith(dto);
      expect(result).toEqual({ message: 'Success' });
    });
  });

  describe('verify', () => {
    it('should call tenantsService.verify with token and email', async () => {
      const dto = { token: '123', email: 'admin@acme.com' };
      mockTenantsService.verify.mockResolvedValue({ tenantId: 'abc' });

      const result = await controller.verify(dto);
      expect(service.verify).toHaveBeenCalledWith('123', 'admin@acme.com');
      expect(result).toEqual({ tenantId: 'abc' });
    });
  });

  describe('getTenant', () => {
    it('should call tenantsService.getTenant', async () => {
      mockTenantsService.getTenant.mockResolvedValue({ id: 'tenant-id' });
      const result = await controller.getTenant('tenant-id');

      expect(service.getTenant).toHaveBeenCalledWith('tenant-id');
      expect(result).toEqual({ id: 'tenant-id' });
    });
  });
});
