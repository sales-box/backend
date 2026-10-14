import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '@/database/prisma.service';
import { TenantAllowlistGuard } from './tenant-allowlist.guard';

const SECRET = 'test-jwt-secret-32-characters-long';

function ctx(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as unknown as ExecutionContext;
}

describe('TenantAllowlistGuard', () => {
  let findFirst: jest.Mock;
  let guard: TenantAllowlistGuard;
  // Real JwtService so verification (and the wrong-secret path) is exercised
  // for real, using the same engine the app signs with.
  const jwt = new JwtService({ secret: SECRET });

  beforeEach(() => {
    findFirst = jest.fn();
    const prisma = {
      connectedAccount: { findFirst },
      // assertTenantActive runs whenever the matched account has a tenant.
      tenant: { findUnique: jest.fn().mockResolvedValue({ status: 'active' }) },
    } as unknown as PrismaService;
    guard = new TenantAllowlistGuard(prisma, jwt);
  });

  const tokenFor = (email: string) =>
    jwt.sign({ sub: 'a1', tenantId: 't1', isAdmin: false, email });

  it('rejects a token that carries no tenant instead of scanning every tenant', async () => {
    // A platform-operator token has no tenantId. The lookup used to spread the
    // tenant predicate away in that case, turning this into a platform-wide
    // search by email — so an operator whose address matched any connected
    // account would pass a TENANT allowlist guard.
    const noTenant = jwt.sign({
      sub: 'op1',
      isAdmin: false,
      email: 'ops@salesbox.com',
    });
    await expect(
      guard.canActivate(ctx(`Bearer ${noTenant}`)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('always scopes the account lookup by tenant', async () => {
    findFirst.mockResolvedValue({
      id: 'a1',
      status: 'connected',
      tenantId: 't1',
    });
    await guard.canActivate(ctx(`Bearer ${tokenFor('se@acme.com')}`));
    const calls = findFirst.mock.calls as Array<
      [{ where: { tenantId?: string } }]
    >;
    expect(calls[0][0].where.tenantId).toBe('t1');
  });

  it('allows a valid token whose account is still connected', async () => {
    findFirst.mockResolvedValue({ id: 'a1', status: 'connected' });
    await expect(
      guard.canActivate(ctx(`Bearer ${tokenFor('se@acme.com')}`)),
    ).resolves.toBe(true);
  });

  it('rejects when the account has been revoked (not connected)', async () => {
    findFirst.mockResolvedValue(null); // no connected account matches
    await expect(
      guard.canActivate(ctx(`Bearer ${tokenFor('se@acme.com')}`)),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a missing token', async () => {
    await expect(guard.canActivate(ctx(undefined))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token signed with the wrong secret', async () => {
    const bad = new JwtService({ secret: 'wrong-secret' }).sign({
      email: 'se@acme.com',
    });
    await expect(guard.canActivate(ctx(`Bearer ${bad}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a connected account whose tenant has been suspended', async () => {
    const prisma = {
      connectedAccount: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'a1', status: 'connected', tenantId: 't1' }),
      },
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ status: 'suspended' }),
      },
    } as unknown as PrismaService;
    const suspendedGuard = new TenantAllowlistGuard(prisma, jwt);

    await expect(
      suspendedGuard.canActivate(ctx(`Bearer ${tokenFor('se@acme.com')}`)),
    ).rejects.toThrow(ForbiddenException);
  });
});
