import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminTenantGuard } from './admin-tenant.guard';

/** Builds a fake ExecutionContext carrying the given request. */
function ctx(request: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

/** Guard wired to a Reflector that reports the given @AllowNonAdmin() state. */
function guardWith(allowNonAdmin: boolean): AdminTenantGuard {
  const reflector = {
    getAllAndOverride: () => allowNonAdmin,
  } as unknown as Reflector;
  return new AdminTenantGuard(reflector);
}

describe('AdminTenantGuard', () => {
  const guard = guardWith(false);

  it('allows an admin reaching their own tenant (URL param)', () => {
    const req = {
      user: { isAdmin: true, tenantId: 't1' },
      params: { tenantId: 't1' },
    };
    expect(guard.canActivate(ctx(req))).toBe(true);
  });

  it('rejects a non-admin', () => {
    const req = {
      user: { isAdmin: false, tenantId: 't1' },
      params: { tenantId: 't1' },
    };
    expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
  });

  it('rejects a missing badge (no admin login yet)', () => {
    const req = { params: { tenantId: 't1' } };
    expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
  });

  it('rejects an admin who edits the id to another tenant (URL param)', () => {
    const req = {
      user: { isAdmin: true, tenantId: 't1' },
      params: { tenantId: 't2' },
    };
    expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
  });

  it('rejects tampering with the analytics ?tenantId query param', () => {
    const req = {
      user: { isAdmin: true, tenantId: 't1' },
      query: { tenantId: 't2' },
    };
    expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
  });

  describe('@AllowNonAdmin() routes', () => {
    const seGuard = guardWith(true);

    it('allows a non-admin tenant user (e.g. an SE reporting a gap)', () => {
      const req = { user: { isAdmin: false, tenantId: 't1' } };
      expect(seGuard.canActivate(ctx(req))).toBe(true);
    });

    it('still rejects an unauthenticated caller', () => {
      const req = {};
      expect(() => seGuard.canActivate(ctx(req))).toThrow(ForbiddenException);
    });
  });
});
