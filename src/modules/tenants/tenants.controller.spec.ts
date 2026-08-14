import { Test, TestingModule } from '@nestjs/testing';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mocked-uuid-token'),
}));

describe('TenantsController', () => {
  let controller: TenantsController;

  const mockTenantsService = {
    signup: jest.fn(),
    resendVerification: jest.fn(),
    verify: jest.fn(),
    getTenant: jest.fn(),
    updateTenant: jest.fn(),
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
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminTenantGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TenantsController>(TenantsController);
    jest.clearAllMocks();
  });

  describe('signup', () => {
    it('should call tenantsService.signup', async () => {
      const dto = { companyName: 'Acme', adminEmail: 'admin@acme.com' };
      mockTenantsService.signup.mockResolvedValue({ message: 'Success' });

      const result = await controller.signup(dto);
      expect(mockTenantsService.signup).toHaveBeenCalledWith(dto);
      expect(result).toEqual({ message: 'Success' });
    });
  });

  describe('resendVerification', () => {
    it('should call tenantsService.resendVerification', async () => {
      const dto = { email: 'admin@acme.com', companyName: 'Acme' };
      mockTenantsService.resendVerification.mockResolvedValue({
        message: 'Resent',
      });

      const result = await controller.resendVerification(dto);
      expect(mockTenantsService.resendVerification).toHaveBeenCalledWith(dto);
      expect(result).toEqual({ message: 'Resent' });
    });
  });

  describe('verify', () => {
    it('should call tenantsService.verify with token and email', async () => {
      const dto = { token: '123', email: 'admin@acme.com' };
      mockTenantsService.verify.mockResolvedValue({ tenantId: 'abc' });

      const result = await controller.verify(dto);
      expect(mockTenantsService.verify).toHaveBeenCalledWith(
        '123',
        'admin@acme.com',
      );
      expect(result).toEqual({ tenantId: 'abc' });
    });
  });

  describe('getTenant', () => {
    it('should call tenantsService.getTenant', async () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      mockTenantsService.getTenant.mockResolvedValue({ id: validUuid });
      const result = await controller.getTenant(validUuid);

      expect(mockTenantsService.getTenant).toHaveBeenCalledWith(validUuid);
      expect(result).toEqual({ id: validUuid });
    });
  });

  describe('updateTenant', () => {
    it('should call tenantsService.updateTenant', async () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      const dto = { companyName: 'Updated Acme' };
      const expectedResult = {
        id: validUuid,
        companyName: 'Updated Acme',
        tier: 'free',
        status: 'active',
      };
      mockTenantsService.updateTenant.mockResolvedValue(expectedResult);

      const result = await controller.updateTenant(validUuid, dto);
      expect(mockTenantsService.updateTenant).toHaveBeenCalledWith(
        validUuid,
        dto,
      );
      expect(result).toEqual(expectedResult);
    });
  });
});
