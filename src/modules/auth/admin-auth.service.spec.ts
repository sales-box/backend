import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash } from '@node-rs/argon2';
import { AdminAuthService } from './admin-auth.service';
import { PrismaService } from '../../database/prisma.service';

describe('AdminAuthService', () => {
  let service: AdminAuthService;
  let findFirst: jest.Mock;
  let count: jest.Mock;
  let update: jest.Mock;
  let tenantFindUnique: jest.Mock;
  let signAsync: jest.Mock;

  const prismaFor = () =>
    ({
      connectedAccount: { findFirst, count, update },
      tenant: { findUnique: tenantFindUnique },
    }) as unknown as PrismaService;

  beforeEach(() => {
    findFirst = jest.fn();
    // Default: exactly one match — the normal single-tenant path.
    count = jest.fn().mockResolvedValue(1);
    update = jest.fn().mockResolvedValue({ id: 'acc-1' });
    tenantFindUnique = jest.fn();
    signAsync = jest.fn().mockResolvedValue('signed.jwt.token');
    service = new AdminAuthService(prismaFor(), {
      signAsync,
    } as unknown as JwtService);
  });

  describe('adminLoginWithPassword', () => {
    it('issues a JWT with the account claims on a correct password', async () => {
      const passwordHash = await hash('correct-password');
      findFirst.mockResolvedValue({
        id: 'acc-1',
        email: 'admin@acme.com',
        tenantId: 'tenant-a',
        isAdmin: true,
        passwordHash,
      });

      const { token } = await service.adminLoginWithPassword(
        'admin@acme.com',
        'correct-password',
      );

      expect(token).toBe('signed.jwt.token');
      expect(signAsync).toHaveBeenCalledWith({
        sub: 'acc-1',
        tenantId: 'tenant-a',
        isAdmin: true,
        email: 'admin@acme.com',
      });
    });

    it('rejects a wrong password with a generic 401 (no enumeration)', async () => {
      const passwordHash = await hash('correct-password');
      findFirst.mockResolvedValue({
        id: 'acc-1',
        email: 'admin@acme.com',
        tenantId: 'tenant-a',
        isAdmin: true,
        passwordHash,
      });

      await expect(
        service.adminLoginWithPassword('admin@acme.com', 'wrong'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(signAsync).not.toHaveBeenCalled();
    });

    it('rejects when the account has no password set', async () => {
      findFirst.mockResolvedValue({
        id: 'acc-1',
        email: 'admin@acme.com',
        isAdmin: true,
        passwordHash: null,
      });

      await expect(
        service.adminLoginWithPassword('admin@acme.com', 'x'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects an unknown email with the same 401', async () => {
      findFirst.mockResolvedValue(null);

      await expect(
        service.adminLoginWithPassword('ghost@acme.com', 'x'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws ConflictException when the same email is an admin for multiple tenants', async () => {
      // count > 1 means the same email exists as admin under two different tenants.
      count.mockResolvedValue(2);

      await expect(
        service.adminLoginWithPassword('shared@acme.com', 'x'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(findFirst).not.toHaveBeenCalled();
      expect(signAsync).not.toHaveBeenCalled();
    });
  });

  describe('setAdminPassword (identity-linking)', () => {
    const activeTenant = { id: 'tenant-a', status: 'active' };

    it('links the password onto the SAME account row (no duplicate)', async () => {
      tenantFindUnique.mockResolvedValue(activeTenant);
      findFirst
        .mockResolvedValueOnce({ id: 'acc-1', passwordHash: null }) // by email
        .mockResolvedValueOnce(null); // no other admin

      const res = await service.setAdminPassword(
        'admin@acme.com',
        'a-strong-password',
        'tenant-a',
      );

      expect(res).toEqual({ linked: true });
      expect(update).toHaveBeenCalledTimes(1);
      const calls = update.mock.calls as Array<
        [
          {
            where: { id: string };
            data: { isAdmin: boolean; tenantId: string; passwordHash: string };
          },
        ]
      >;
      const arg = calls[0][0];
      expect(arg.where).toEqual({ id: 'acc-1' });
      expect(arg.data.isAdmin).toBe(true);
      expect(arg.data.tenantId).toBe('tenant-a');
      expect(typeof arg.data.passwordHash).toBe('string');
      expect(arg.data.passwordHash).not.toBe('a-strong-password'); // hashed
    });

    it('rejects when the tenant is not active', async () => {
      tenantFindUnique.mockResolvedValue({ id: 'tenant-a', status: 'pending' });

      await expect(
        service.setAdminPassword('admin@acme.com', 'x-password', 'tenant-a'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it('rejects when no Google account exists for the email', async () => {
      tenantFindUnique.mockResolvedValue(activeTenant);
      findFirst
        .mockResolvedValueOnce(null) // tenant-scoped
        .mockResolvedValueOnce(null); // email-only fallback

      await expect(
        service.setAdminPassword('admin@acme.com', 'x-password', 'tenant-a'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('falls back to email-only lookup when ConnectedAccount has tenantId=null', async () => {
      tenantFindUnique.mockResolvedValue(activeTenant);
      findFirst
        .mockResolvedValueOnce(null) // tenant-scoped: not found
        .mockResolvedValueOnce({
          id: 'acc-1',
          passwordHash: null,
          tenantId: null,
          isAdmin: false,
        }) // fallback: found with null tenantId
        .mockResolvedValueOnce(null); // no other admin

      const res = await service.setAdminPassword(
        'admin@acme.com',
        'a-strong-password',
        'tenant-a',
      );

      expect(res).toEqual({ linked: true });
      expect(findFirst).toHaveBeenCalledTimes(3);
      expect(findFirst).toHaveBeenNthCalledWith(2, {
        where: { email: 'admin@acme.com', tenantId: null, isAdmin: false },
      });
    });

    it('rejects when a password is already set', async () => {
      tenantFindUnique.mockResolvedValue(activeTenant);
      findFirst.mockResolvedValueOnce({ id: 'acc-1', passwordHash: 'x' });

      await expect(
        service.setAdminPassword('admin@acme.com', 'x-password', 'tenant-a'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a second admin for the same tenant', async () => {
      tenantFindUnique.mockResolvedValue(activeTenant);
      findFirst
        .mockResolvedValueOnce({ id: 'acc-2', passwordHash: null })
        .mockResolvedValueOnce({ id: 'acc-1' }); // existing admin

      await expect(
        service.setAdminPassword('second@acme.com', 'x-password', 'tenant-a'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(update).not.toHaveBeenCalled();
    });
  });
});
