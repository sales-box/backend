import { ForbiddenException } from '@nestjs/common';
import { assertTenantActive } from './assert-tenant-active';
import type { PrismaService } from '@/database/prisma.service';

function prismaWith(status: string | null): PrismaService {
  return {
    tenant: {
      findUnique: jest.fn().mockResolvedValue(status ? { status } : null),
    },
  } as unknown as PrismaService;
}

describe('assertTenantActive', () => {
  it('resolves for an active tenant', async () => {
    await expect(
      assertTenantActive(prismaWith('active'), 't1'),
    ).resolves.toBeUndefined();
  });

  it.each(['suspended', 'offboarded', 'pending', 'abandoned'])(
    'rejects a %s tenant',
    async (status) => {
      await expect(
        assertTenantActive(prismaWith(status), 't1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('rejects when the tenant does not exist', async () => {
    await expect(
      assertTenantActive(prismaWith(null), 't1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
