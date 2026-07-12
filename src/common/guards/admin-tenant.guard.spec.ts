import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminTenantGuard } from './admin-tenant.guard';

/** Builds a fake ExecutionContext carrying the given request. */
function ctx(request: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AdminTenantGuard', () => {
  const guard = new AdminTenantGuard();

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
});
