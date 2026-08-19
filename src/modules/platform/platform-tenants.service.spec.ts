import { NotFoundException } from '@nestjs/common';
import { PlatformTenantsService } from './platform-tenants.service';
import type { PrismaService } from '../../database/prisma.service';

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
      return { service: new PlatformTenantsService(prisma), groupBy };
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
      return { service: new PlatformTenantsService(prisma) };
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
});
