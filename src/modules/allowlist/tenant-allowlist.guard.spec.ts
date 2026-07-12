import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
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

  beforeEach(() => {
    findFirst = jest.fn();
    const prisma = {
      connectedAccount: { findFirst },
    } as unknown as PrismaService;
    const config = {
      getOrThrow: () => SECRET,
    } as unknown as ConfigService;
    guard = new TenantAllowlistGuard(prisma, config);
  });

  const tokenFor = (email: string) => jwt.sign({ email, role: 'se' }, SECRET);

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
    const bad = jwt.sign({ email: 'se@acme.com' }, 'wrong-secret');
    await expect(guard.canActivate(ctx(`Bearer ${bad}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
