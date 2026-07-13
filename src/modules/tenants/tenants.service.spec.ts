import { Test, TestingModule } from '@nestjs/testing';
import { TenantsService } from './tenants.service';
import { PrismaService } from '../../database/prisma.service';
import { ConfigService } from '@nestjs/config';
import { AllowlistService } from '../allowlist/allowlist.service';
import {
  NotFoundException,
  BadRequestException,
  GoneException,
} from '@nestjs/common';

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mocked-uuid-token'),
}));

jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: jest.fn().mockResolvedValue(true),
  }),
}));

describe('TenantsService', () => {
  let service: TenantsService;

  const mockTenantCreate = jest.fn<Promise<unknown>, [unknown]>();
  const mockTenantFindUnique = jest.fn<Promise<unknown>, [unknown]>();
  const mockTenantUpdate = jest.fn<Promise<unknown>, [unknown]>();

  const mockPrisma = {
    tenant: {
      create: mockTenantCreate,
      findUnique: mockTenantFindUnique,
      update: mockTenantUpdate,
    },
    $transaction: jest.fn(<T>(cb: (p: unknown) => Promise<T>): Promise<T> =>
      cb(mockPrisma as unknown),
    ),
  } as unknown as PrismaService;

  const mockConfig = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'SMTP_PORT') return '1025';
      return 'mock-value';
    }),
  } as unknown as ConfigService;

  const mockAllowlistService = {
    grantAccess: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: AllowlistService, useValue: mockAllowlistService },
      ],
    }).compile();

    service = module.get<TenantsService>(TenantsService);
    jest.clearAllMocks();
  });

  describe('signup', () => {
    it('should create a pending tenant and attempt to send an email', async () => {
      mockTenantCreate.mockResolvedValue({ id: 'tenant-123' });

      const dto = { companyName: 'Test Inc', adminEmail: 'admin@test.com' };
      const result = await service.signup(dto);

      const arg = mockTenantCreate.mock.calls[0][0] as {
        data: { companyName: string; status: string };
      };
      expect(arg.data.companyName).toBe('Test Inc');
      expect(arg.data.status).toBe('pending');
      expect(result.message).toContain('Signup successful');
    });
  });

  describe('verify', () => {
    it('should throw NotFoundException if token is invalid', async () => {
      mockTenantFindUnique.mockResolvedValue(null);
      await expect(
        service.verify('bad-token', 'admin@test.com'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if tenant is already active', async () => {
      mockTenantFindUnique.mockResolvedValue({ status: 'active' });
      await expect(
        service.verify('valid-token', 'admin@test.com'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw GoneException if token has expired', async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockTenantFindUnique.mockResolvedValue({
        status: 'pending',
        emailVerificationExpiresAt: pastDate,
      });

      await expect(
        service.verify('expired-token', 'admin@test.com'),
      ).rejects.toThrow(GoneException);
    });

    it('should activate the tenant successfully', async () => {
      const futureDate = new Date();
      futureDate.setHours(futureDate.getHours() + 1);

      const mockTenant = {
        id: 'tenant-123',
        status: 'pending',
        emailVerificationExpiresAt: futureDate,
      };

      mockTenantFindUnique.mockResolvedValue(mockTenant);
      mockTenantUpdate.mockResolvedValue({
        ...mockTenant,
        status: 'active',
      });

      const result = await service.verify('good-token', 'admin@test.com');

      const arg = mockTenantUpdate.mock.calls[0][0] as {
        where: { id: string };
        data: { status: string };
      };
      expect(arg.where.id).toBe('tenant-123');
      expect(arg.data.status).toBe('active');
      expect(result.tenantId).toBe('tenant-123');
    });
  });
});
