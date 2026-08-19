import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminTenantGuard } from './admin-tenant.guard';
import type { PrismaService } from '@/database/prisma.service';

/** Builds a fake ExecutionContext carrying the given request. */
function ctx(request: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

/**
 * Guard wired to a Reflector reporting the given @AllowNonAdmin() state and a
 * Prisma stub reporting the given tenant status (default: active).
 */
function guardWith(allowNonAdmin: boolean, tenantStatus = 'active') {
  const reflector = {
    getAllAndOverride: () => allowNonAdmin,
  } as unknown as Reflector;
  const prisma = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ status: tenantStatus }),
    },
  } as unknown as PrismaService;
  return new AdminTenantGuard(reflector, prisma);
}

describe('AdminTenantGuard', () => {
  const guard = guardWith(false);

  it('allows an admin reaching their own tenant (URL param)', async () => {
    const req = {
      user: { isAdmin: true, tenantId: 't1' },
      params: { tenantId: 't1' },
    };
    await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
  });

  it('rejects a non-admin', async () => {
    const req = {
      user: { isAdmin: false, tenantId: 't1' },
      params: { tenantId: 't1' },
    };
    await expect(guard.canActivate(ctx(req))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects a missing badge (no admin login yet)', async () => {
    const req = { params: { tenantId: 't1' } };
    await expect(guard.canActivate(ctx(req))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects an admin who edits the id to another tenant (URL param)', async () => {
    const req = {
      user: { isAdmin: true, tenantId: 't1' },
      params: { tenantId: 't2' },
    };
    await expect(guard.canActivate(ctx(req))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects tampering with the analytics ?tenantId query param', async () => {
    const req = {
      user: { isAdmin: true, tenantId: 't1' },
      query: { tenantId: 't2' },
    };
    await expect(guard.canActivate(ctx(req))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects an admin whose tenant has been suspended', async () => {
    const suspended = guardWith(false, 'suspended');
    const req = {
      user: { isAdmin: true, tenantId: 't1' },
      params: { tenantId: 't1' },
    };
    await expect(suspended.canActivate(ctx(req))).rejects.toThrow(
      ForbiddenException,
    );
  });

  describe('@AllowNonAdmin() routes', () => {
    it('allows a non-admin tenant user (e.g. an SE reporting a gap)', async () => {
      const seGuard = guardWith(true);
      const req = { user: { isAdmin: false, tenantId: 't1' } };
      await expect(seGuard.canActivate(ctx(req))).resolves.toBe(true);
    });

    it('still rejects an unauthenticated caller', async () => {
      const seGuard = guardWith(true);
      const req = {};
      await expect(seGuard.canActivate(ctx(req))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects a non-admin whose tenant has been suspended', async () => {
      const seGuard = guardWith(true, 'suspended');
      const req = { user: { isAdmin: false, tenantId: 't1' } };
      await expect(seGuard.canActivate(ctx(req))).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
