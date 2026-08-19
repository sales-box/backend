import { ConflictException, NotFoundException } from '@nestjs/common';
import { PlatformTenantsService } from './platform-tenants.service';
import type { PrismaService } from '../../database/prisma.service';
import type { AllowlistService } from '../allowlist/allowlist.service';

/** An AllowlistService stub exposing the one method the service uses. */
function stubAllowlist(
  offboardTenant = jest.fn().mockResolvedValue(undefined),
) {
  return {
    allowlist: { offboardTenant } as unknown as AllowlistService,
    offboardTenant,
  };
}

describe('PlatformTenantsService', () => {
  describe('list', () => {
    function makeService(
      tenants: Array<Record<string, unknown>>,
      groups: Array<{ tenantId: string; _count: { _all: number } }>,
    ) {
      const count = jest.fn().mockResolvedValue(tenants.length);
      const findMany = jest.fn().mockResolvedValue(tenants);
      const groupBy = jest.fn().mockResolvedValue(groups);
      const prisma = {
        tenant: { count, findMany },
        allowlistEntry: { groupBy },
      } as unknown as PrismaService;
      return {
        service: new PlatformTenantsService(prisma, stubAllowlist().allowlist),
        groupBy,
      };
    }

    it('merges each tenant with its active-seat count', async () => {
      const { service } = makeService(
        [
          { id: 't1', companyName: 'Acme', status: 'active', tier: 2 },
          { id: 't2', companyName: 'Beta', status: 'suspended', tier: 1 },
        ],
        [{ tenantId: 't1', _count: { _all: 3 } }],
      );

      const res = await service.list(1, 20);

      expect(res.data).toEqual([
        {
          id: 't1',
          companyName: 'Acme',
          status: 'active',
          tier: 2,
          seCount: 3,
        },
        {
          id: 't2',
          companyName: 'Beta',
          status: 'suspended',
          tier: 1,
          seCount: 0,
        },
      ]);
    });

    it('skips the seat-count query when there are no tenants', async () => {
      const { service, groupBy } = makeService([], []);
      const res = await service.list(1, 20);
      expect(res.data).toEqual([]);
      expect(groupBy).not.toHaveBeenCalled();
    });
  });

  describe('getDetail', () => {
    function makeService(tenant: Record<string, unknown> | null) {
      const prisma = {
        tenant: { findUnique: jest.fn().mockResolvedValue(tenant) },
        allowlistEntry: { count: jest.fn().mockResolvedValue(2) },
        document: { count: jest.fn().mockResolvedValue(5) },
        generalAnalysis: { count: jest.fn().mockResolvedValue(42) },
        connectedAccount: {
          aggregate: jest.fn().mockResolvedValue({
            _max: { lastLoginAt: new Date('2026-08-19') },
          }),
        },
      } as unknown as PrismaService;
      return {
        service: new PlatformTenantsService(prisma, stubAllowlist().allowlist),
      };
    }

    it('returns operational detail with counts', async () => {
      const { service } = makeService({
        id: 't1',
        companyName: 'Acme',
        status: 'active',
        tier: 2,
        createdAt: new Date('2026-01-01'),
      });

      const res = await service.getDetail('t1');

      expect(res).toMatchObject({
        id: 't1',
        companyName: 'Acme',
        status: 'active',
        tier: 2,
        seCount: 2,
        docCount: 5,
        emailCount: 42,
      });
      expect(res.lastActivityAt).toEqual(new Date('2026-08-19'));
    });

    it('throws NotFound for an unknown tenant', async () => {
      const { service } = makeService(null);
      await expect(service.getDetail('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('changeStatus', () => {
    function makeService(status: string | null) {
      const findUnique = jest
        .fn()
        .mockResolvedValue(status ? { status } : null);
      const update = jest
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ id: 't1', ...data }),
        );
      const prisma = {
        tenant: { findUnique, update },
      } as unknown as PrismaService;
      const { allowlist, offboardTenant } = stubAllowlist();
      return {
        service: new PlatformTenantsService(prisma, allowlist),
        update,
        offboardTenant,
      };
    }

    it('suspends an active tenant', async () => {
      const { service, update } = makeService('active');
      const res = await service.changeStatus('t1', 'suspend');
      expect(res).toEqual({ id: 't1', status: 'suspended' });
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'suspended' } }),
      );
    });

    it('reactivates a suspended tenant', async () => {
      const { service, update } = makeService('suspended');
      const res = await service.changeStatus('t1', 'activate');
      expect(res).toEqual({ id: 't1', status: 'active' });
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'active' } }),
      );
    });

    it('offboards via the existing terminal path (revokes accounts)', async () => {
      const { service, offboardTenant, update } = makeService('active');
      const res = await service.changeStatus('t1', 'offboard');
      expect(offboardTenant).toHaveBeenCalledWith('t1');
      expect(update).not.toHaveBeenCalled();
      expect(res).toEqual({ id: 't1', status: 'offboarded' });
    });

    it('rejects an illegal transition (suspend a suspended tenant) with 409', async () => {
      const { service } = makeService('suspended');
      await expect(
        service.changeStatus('t1', 'suspend'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects reactivating a tenant that is not suspended with 409', async () => {
      const { service } = makeService('active');
      await expect(
        service.changeStatus('t1', 'activate'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws NotFound for an unknown tenant', async () => {
      const { service } = makeService(null);
      await expect(service.changeStatus('x', 'suspend')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('changeTier', () => {
    function makeService(exists: boolean) {
      const findUnique = jest
        .fn()
        .mockResolvedValue(exists ? { id: 't1' } : null);
      const update = jest
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ id: 't1', ...data }),
        );
      const prisma = {
        tenant: { findUnique, update },
      } as unknown as PrismaService;
      return {
        service: new PlatformTenantsService(prisma, stubAllowlist().allowlist),
        update,
      };
    }

    it('sets the tier', async () => {
      const { service, update } = makeService(true);
      const res = await service.changeTier('t1', 3);
      expect(res).toEqual({ id: 't1', tier: 3 });
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { tier: 3 } }),
      );
    });

    it('throws NotFound for an unknown tenant', async () => {
      const { service } = makeService(false);
      await expect(service.changeTier('x', 2)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
