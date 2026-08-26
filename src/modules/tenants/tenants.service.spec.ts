import { Test, TestingModule } from '@nestjs/testing';
import { TenantsService } from './tenants.service';
import { PrismaService } from '../../database/prisma.service';
import { ConfigService } from '@nestjs/config';
import { AllowlistService } from '../allowlist/allowlist.service';
import { Prisma } from '@prisma/client';
import {
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
  BadRequestException,
  GoneException,
} from '@nestjs/common';

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mocked-uuid-token'),
}));

const mockSendMail = jest.fn<
  Promise<unknown>,
  [{ from: string; text: string; html: string }]
>();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: (arg: { from: string; text: string; html: string }) =>
      mockSendMail(arg),
  }),
}));

describe('TenantsService', () => {
  let service: TenantsService;

  const mockTenantCreate = jest.fn<Promise<unknown>, [unknown]>();
  const mockTenantFindUnique = jest.fn<Promise<unknown>, [unknown]>();
  const mockTenantFindFirst = jest.fn<Promise<unknown>, [unknown]>();
  const mockTenantUpdate = jest.fn<Promise<unknown>, [unknown]>();

  const mockPrisma = {
    tenant: {
      create: mockTenantCreate,
      findUnique: mockTenantFindUnique,
      findFirst: mockTenantFindFirst,
      update: mockTenantUpdate,
    },
    $transaction: jest.fn(<T>(cb: (p: unknown) => Promise<T>): Promise<T> =>
      cb(mockPrisma as unknown),
    ),
  } as unknown as PrismaService;

  const mockConfig = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'SMTP_PORT') return '1025';
      if (key === 'FRONTEND_DASHBOARD_URL')
        return 'http://localhost:5173/dashboard';
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

  describe('signup — one account per email address', () => {
    // Before this rule, signing up again with a different company name simply
    // created a SECOND tenant on the same address. One person could end up
    // owning several half-finished companies, and "resend my link" became
    // ambiguous: it picks the newest pending tenant, so the older one could
    // never be verified at all.

    it.each(['active', 'suspended', 'offboarded'])(
      'refuses a second signup when the address already has a %s account',
      async (status) => {
        mockTenantFindFirst.mockResolvedValue({
          id: 'tenant-live',
          status,
          adminEmail: 'admin@test.com',
        });

        await expect(
          service.signup({
            companyName: 'Another Co',
            adminEmail: 'admin@test.com',
          }),
        ).rejects.toThrow(ConflictException);

        expect(mockTenantCreate).not.toHaveBeenCalled();
        expect(mockSendMail).not.toHaveBeenCalled();
      },
    );

    it('does not leak which company the address belongs to', async () => {
      mockTenantFindFirst.mockResolvedValue({
        id: 'tenant-live',
        status: 'active',
        companyName: 'Secret Holdings',
        adminEmail: 'admin@test.com',
      });

      await expect(
        service.signup({
          companyName: 'Another Co',
          adminEmail: 'admin@test.com',
        }),
      ).rejects.toThrow(ConflictException);

      // The refusal must not tell an anonymous caller which company owns the
      // address.
      const thrown = await service
        .signup({ companyName: 'Another Co', adminEmail: 'admin@test.com' })
        .catch((e: unknown) => e);
      expect((thrown as Error).message).not.toContain('Secret Holdings');
    });

    it('reclaims an in-flight pending signup instead of duplicating it', async () => {
      mockTenantFindFirst.mockResolvedValue({
        id: 'tenant-pending',
        status: 'pending',
        adminEmail: 'admin@test.com',
      });
      mockTenantUpdate.mockResolvedValue({ id: 'tenant-pending' });
      mockSendMail.mockResolvedValue(true);

      await service.signup({
        companyName: 'Corrected Name Ltd',
        adminEmail: 'Admin@Test.com',
      });

      expect(mockTenantCreate).not.toHaveBeenCalled();
      expect(mockTenantUpdate).toHaveBeenCalledWith({
        where: { id: 'tenant-pending' },
        data: expect.objectContaining({
          // the corrected company name wins, and the address is normalised
          companyName: 'Corrected Name Ltd',
          adminEmail: 'admin@test.com',
          status: 'pending',
        }) as Record<string, unknown>,
      });
    });

    it('revives an abandoned signup rather than locking the person out', async () => {
      // `abandoned` is only a pending signup the 7-day cleanup aged out. It is
      // not a real account, so refusing it would mean somebody who was slow the
      // first time could never register that address again.
      mockTenantFindFirst.mockResolvedValue({
        id: 'tenant-abandoned',
        status: 'abandoned',
        adminEmail: 'admin@test.com',
      });
      mockTenantUpdate.mockResolvedValue({ id: 'tenant-abandoned' });
      mockSendMail.mockResolvedValue(true);

      const result = await service.signup({
        companyName: 'Second Attempt Ltd',
        adminEmail: 'admin@test.com',
      });

      expect(mockTenantUpdate).toHaveBeenCalledWith({
        where: { id: 'tenant-abandoned' },
        data: expect.objectContaining({ status: 'pending' }) as Record<
          string,
          unknown
        >,
      });
      expect(result.message).toContain('Signup successful');
    });
  });

  describe('signup', () => {
    it('should create a pending tenant and attempt to send an email', async () => {
      mockTenantFindFirst.mockResolvedValue(null);
      mockTenantCreate.mockResolvedValue({ id: 'tenant-123' });
      mockSendMail.mockResolvedValue(true);

      const dto = { companyName: 'Test Inc', adminEmail: 'admin@test.com' };
      const result = await service.signup(dto);

      const arg = mockTenantCreate.mock.calls[0][0] as {
        data: { companyName: string; status: string };
      };
      expect(arg.data.companyName).toBe('Test Inc');
      expect(arg.data.status).toBe('pending');
      expect(result.message).toContain('Signup successful');

      // The email links to the FRONTEND /verify page (not the raw API), so the
      // browser lands on a real page that then routes to set-password.
      const mailArg = mockSendMail.mock.calls[0][0];
      expect(mailArg.html).toContain('http://localhost:5173/verify?token=');
      expect(mailArg.html).not.toContain('/tenants/verify');
      // Regression: must send AS the authenticated SMTP_USER (mocked to
      // 'mock-value'), never a hard-coded foreign From that Gmail rejects.
      expect(mailArg.from).toBe('mock-value');
      expect(mailArg.from).not.toContain('salescopilot.com');
      // And carry a plain-text fallback with the same verify link.
      expect(mailArg.text).toContain('http://localhost:5173/verify?token=');
    });

    it('should update existing pending tenant instead of creating a duplicate', async () => {
      mockTenantFindFirst.mockResolvedValue({
        id: 'existing-tenant-id',
        status: 'pending',
      });
      mockTenantUpdate.mockResolvedValue({
        id: 'existing-tenant-id',
        status: 'pending',
      });
      mockSendMail.mockResolvedValue(true);

      const dto = { companyName: 'Test Inc', adminEmail: 'admin@test.com' };
      const result = await service.signup(dto);

      expect(mockTenantUpdate).toHaveBeenCalledWith({
        where: { id: 'existing-tenant-id' },
        data: expect.objectContaining({
          emailVerificationToken: 'mocked-uuid-token',
        }) as Record<string, unknown>,
      });
      expect(mockTenantCreate).not.toHaveBeenCalled();
      expect(result.message).toContain('Signup successful');
    });
  });

  describe('resendVerification', () => {
    it('should update pending tenant token and resend verification email', async () => {
      mockTenantFindFirst.mockResolvedValue({
        id: 'pending-123',
        status: 'pending',
      });
      mockTenantUpdate.mockResolvedValue({
        id: 'pending-123',
        status: 'pending',
      });
      mockSendMail.mockResolvedValue(true);

      const result = await service.resendVerification({
        email: 'admin@test.com',
        companyName: 'Test Inc',
      });

      expect(mockTenantUpdate).toHaveBeenCalledWith({
        where: { id: 'pending-123' },
        data: expect.objectContaining({
          emailVerificationToken: 'mocked-uuid-token',
        }) as Record<string, unknown>,
      });
      expect(mockSendMail).toHaveBeenCalled();
      expect(result.message).toContain(
        'Verification email resent successfully',
      );
    });

    it('resolves the tenant by the signup address, not by recency', async () => {
      mockTenantFindFirst.mockResolvedValue({
        id: 'pending-123',
        status: 'pending',
        adminEmail: 'admin@test.com',
      });
      mockTenantUpdate.mockResolvedValue({ id: 'pending-123' });
      mockSendMail.mockResolvedValue(true);

      await service.resendVerification({ email: '  Admin@Test.com ' });

      // The old implementation fell back to `orderBy: { createdAt: 'desc' }`
      // over every pending tenant when companyName was absent, and mailed that
      // stranger's token to the caller.
      expect(mockTenantFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'pending',
            adminEmail: 'admin@test.com',
          }) as Record<string, unknown>,
        }),
      );
    });

    it('says nothing and sends nothing when the address has no pending signup', async () => {
      mockTenantFindFirst.mockResolvedValue(null);

      const result = await service.resendVerification({
        email: 'nobody@test.com',
      });

      // Answering differently for a known and an unknown address would turn
      // this endpoint into an account-enumeration oracle, so the response is
      // deliberately identical — but nothing is rotated and nothing is mailed.
      expect(result.message).toContain('Verification email resent');
      expect(mockTenantUpdate).not.toHaveBeenCalled();
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('reports a send failure instead of claiming success', async () => {
      mockTenantFindFirst.mockResolvedValue({
        id: 'pending-123',
        status: 'pending',
        adminEmail: 'admin@test.com',
      });
      mockTenantUpdate.mockResolvedValue({ id: 'pending-123' });
      mockSendMail.mockRejectedValue(new Error('smtp unreachable'));

      // This used to log the failure and return "resent successfully", so a
      // broken SMTP host looked exactly like a delivered email.
      await expect(
        service.resendVerification({ email: 'admin@test.com' }),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('verify', () => {
    it('refuses a valid token presented with a different address', async () => {
      mockTenantFindUnique.mockResolvedValue({
        id: 'pending-123',
        status: 'pending',
        adminEmail: 'owner@test.com',
        emailVerificationExpiresAt: null,
      });

      // The address used to be logged and then ignored, so any token that
      // reached any inbox activated the company for whoever presented it.
      await expect(
        service.verify('good-token', 'stranger@test.com'),
      ).rejects.toThrow(NotFoundException);
      expect(mockTenantUpdate).not.toHaveBeenCalled();
    });

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

  describe('getTenant', () => {
    it('should throw NotFoundException if ID is not a valid UUID', async () => {
      await expect(service.getTenant('resend-verification')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return tenant when valid UUID is provided', async () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      mockTenantFindUnique.mockResolvedValue({
        id: validUuid,
        companyName: 'Acme',
      });
      const result = await service.getTenant(validUuid);
      expect(result).toEqual({ id: validUuid, companyName: 'Acme' });
    });
  });

  describe('updateTenant', () => {
    const validUuid = '123e4567-e89b-12d3-a456-426614174000';

    it('should throw NotFoundException if ID is not a valid UUID', async () => {
      await expect(
        service.updateTenant('invalid-uuid', { companyName: 'New' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should successfully update tenant and return selected fields', async () => {
      const mockResult = {
        id: validUuid,
        companyName: 'New Name',
        tier: 'free',
        status: 'active',
      };
      mockTenantUpdate.mockResolvedValue(mockResult);

      const result = await service.updateTenant(validUuid, {
        companyName: 'New Name',
      });

      expect(mockTenantUpdate).toHaveBeenCalledWith({
        where: { id: validUuid },
        data: { companyName: 'New Name' },
        select: {
          id: true,
          companyName: true,
          tier: true,
          status: true,
        },
      });
      expect(result).toEqual(mockResult);
    });

    it('should throw NotFoundException if tenant does not exist (P2025)', async () => {
      const error = new Prisma.PrismaClientKnownRequestError('An error', {
        code: 'P2025',
        clientVersion: 'mock',
      });
      mockTenantUpdate.mockRejectedValue(error);

      await expect(
        service.updateTenant(validUuid, { companyName: 'New Name' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should rethrow generic errors', async () => {
      const error = new Error('Database connection failed');
      mockTenantUpdate.mockRejectedValue(error);

      await expect(
        service.updateTenant(validUuid, { companyName: 'New Name' }),
      ).rejects.toThrow('Database connection failed');
    });
  });
});
