/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { Test, TestingModule } from '@nestjs/testing';
import { TenantsService } from './tenants.service';
import { PrismaService } from '../../database/prisma.service';
import { ConfigService } from '@nestjs/config';
import {
  NotFoundException,
  BadRequestException,
  GoneException,
} from '@nestjs/common';
import * as nodemailer from 'nodemailer';

// Mock UUID to fix the Jest ESM SyntaxError and ensure predictable tokens
jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mocked-uuid-token'),
}));

// Mock nodemailer to prevent actual emails from sending during tests
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: jest.fn().mockResolvedValue(true),
  }),
}));

describe('TenantsService', () => {
  let service: TenantsService;
  let prisma: PrismaService;

  const mockPrisma = {
    tenant: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(async (cb) => cb(mockPrisma)),
  };

  const mockConfig = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'SMTP_PORT') return '1025';
      return 'mock-value';
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<TenantsService>(TenantsService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  describe('signup', () => {
    it('should create a pending tenant and attempt to send an email', async () => {
      mockPrisma.tenant.create.mockResolvedValue({ id: 'tenant-123' });

      const dto = { companyName: 'Test Inc', adminEmail: 'admin@test.com' };
      const result = await service.signup(dto);

      expect(prisma.tenant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            companyName: 'Test Inc',
            status: 'pending',
          }),
        }),
      );
      expect(result.message).toContain('Signup successful');
    });
  });

  describe('verify', () => {
    it('should throw NotFoundException if token is invalid', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(null);
      await expect(
        service.verify('bad-token', 'admin@test.com'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if tenant is already active', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue({ status: 'active' });
      await expect(
        service.verify('valid-token', 'admin@test.com'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw GoneException if token has expired', async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockPrisma.tenant.findUnique.mockResolvedValue({
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

      mockPrisma.tenant.findUnique.mockResolvedValue(mockTenant);
      mockPrisma.tenant.update.mockResolvedValue({
        ...mockTenant,
        status: 'active',
      });

      const result = await service.verify('good-token', 'admin@test.com');

      expect(prisma.tenant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tenant-123' },
          data: expect.objectContaining({ status: 'active' }),
        }),
      );
      expect(result.tenantId).toBe('tenant-123');
    });
  });
});
