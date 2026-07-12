import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AllowlistService } from './allowlist.service';
import { PrismaService } from '@/database/prisma.service';
import { EmailNotifyService } from '../email-notify/email-notify.service';

type UpdateArg = {
  where: Record<string, string>;
  data: { status: string; verifiedAt?: Date; revokedAt?: Date };
};

describe('AllowlistService', () => {
  let prisma: {
    allowlistEntry: {
      findFirst: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
      upsert: jest.Mock;
    };
    connectedAccount: { updateMany: jest.Mock };
    tenant: { update: jest.Mock; findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let email: { sendSeInvite: jest.Mock };
  let service: AllowlistService;

  beforeEach(() => {
    prisma = {
      allowlistEntry: {
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
        upsert: jest.fn(),
      },
      connectedAccount: { updateMany: jest.fn() },
      tenant: { update: jest.fn(), findUnique: jest.fn() },
      // Runs the array of operations and resolves — enough for these unit tests.
      $transaction: jest.fn().mockResolvedValue(undefined),
    };
    email = { sendSeInvite: jest.fn() };
    service = new AllowlistService(
      prisma as unknown as PrismaService,
      email as unknown as EmailNotifyService,
    );
  });

  /** First-call, first-arg of a mock, typed so assertions stay type-safe. */
  const firstArg = (mock: jest.Mock): UpdateArg => {
    const calls = mock.mock.calls as UpdateArg[][];
    return calls[0][0];
  };

  describe('verifyAccess', () => {
    it('throws Forbidden when the email is on no allowlist', async () => {
      prisma.allowlistEntry.findFirst.mockResolvedValue(null);
      await expect(service.verifyAccess('ghost@x.com')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.allowlistEntry.update).not.toHaveBeenCalled();
    });

    it('marks a granted entry as verified', async () => {
      prisma.allowlistEntry.findFirst.mockResolvedValue({
        id: 'e1',
        status: 'granted',
      });
      await service.verifyAccess('se@acme.com');

      const arg = firstArg(prisma.allowlistEntry.update);
      expect(arg.where).toEqual({ id: 'e1' });
      expect(arg.data.status).toBe('verified');
      expect(arg.data.verifiedAt).toBeInstanceOf(Date);
    });

    it('does not re-update an already verified entry', async () => {
      prisma.allowlistEntry.findFirst.mockResolvedValue({
        id: 'e1',
        status: 'verified',
      });
      await service.verifyAccess('se@acme.com');
      expect(prisma.allowlistEntry.update).not.toHaveBeenCalled();
    });
  });

  describe('revokeAccess', () => {
    it('revokes the entry and the connected account together', async () => {
      await service.revokeAccess('t1', 'se@acme.com');

      const entryArg = firstArg(prisma.allowlistEntry.updateMany);
      expect(entryArg.where).toEqual({ tenantId: 't1', email: 'se@acme.com' });
      expect(entryArg.data.status).toBe('revoked');

      expect(prisma.connectedAccount.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 't1', email: 'se@acme.com' },
        data: { status: 'revoked' },
      });
      // Both updates must go through ONE transaction (atomic — no half-fail).
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('offboardTenant', () => {
    it('revokes all entries + accounts and marks the tenant offboarded', async () => {
      await service.offboardTenant('t1');

      const entryArg = firstArg(prisma.allowlistEntry.updateMany);
      expect(entryArg.where).toEqual({ tenantId: 't1' });
      expect(entryArg.data.status).toBe('revoked');

      expect(prisma.connectedAccount.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 't1' },
        data: { status: 'revoked' },
      });
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { status: 'offboarded' },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('grantAccess', () => {
    it('throws NotFound when the tenant does not exist', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      await expect(
        service.grantAccess('missing', 'x@acme.com'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects when the tenant is at its tier SE limit', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: 't1', tier: 1 }); // cap 3
      prisma.allowlistEntry.count.mockResolvedValue(3);

      await expect(
        service.grantAccess('t1', 'new@acme.com'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.allowlistEntry.upsert).not.toHaveBeenCalled();
      expect(email.sendSeInvite).not.toHaveBeenCalled();
    });

    it('grants and emails an invite when under the limit', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: 't1', tier: 2 }); // cap 10
      prisma.allowlistEntry.count.mockResolvedValue(4);

      await service.grantAccess('t1', 'new@acme.com');

      expect(prisma.allowlistEntry.upsert).toHaveBeenCalledTimes(1);
      expect(email.sendSeInvite).toHaveBeenCalledWith('new@acme.com');
    });
  });
});
