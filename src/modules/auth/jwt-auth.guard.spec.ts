import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PrismaService } from '@/database/prisma.service';

function contextFor(headers: Record<string, string>): {
  ctx: ExecutionContext;
  req: { headers: Record<string, string>; user?: unknown };
} {
  const req: { headers: Record<string, string>; user?: unknown } = { headers };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => {},
    getClass: () => class {},
  } as unknown as ExecutionContext;
  return { ctx, req };
}

function mockPrisma(tenant?: {
  status: string;
  subscriptionStatus: string;
}): PrismaService {
  return {
    tenant: {
      findUnique: jest.fn().mockResolvedValue(tenant ?? null),
    },
  } as unknown as PrismaService;
}

function mockReflector(exempt = false) {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(exempt);
  return reflector;
}

describe('JwtAuthGuard', () => {
  const claims = {
    sub: 'acc-1',
    tenantId: 'tenant-a',
    isAdmin: true,
    email: 'a@b.com',
  };
  let verifyAsync: jest.Mock;

  beforeEach(() => {
    verifyAsync = jest.fn().mockResolvedValue(claims);
  });

  it('populates req.user from a valid Bearer token', async () => {
    const guard = new JwtAuthGuard(
      { verifyAsync } as unknown as JwtService,
      mockReflector(true),
      mockPrisma(),
    );
    const { ctx, req } = contextFor({ authorization: 'Bearer good.token' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual(claims);
  });

  it('rejects a missing Authorization header', async () => {
    const guard = new JwtAuthGuard(
      { verifyAsync } as unknown as JwtService,
      mockReflector(),
      mockPrisma(),
    );
    const { ctx } = contextFor({});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an invalid/expired token', async () => {
    verifyAsync.mockRejectedValue(new Error('jwt expired'));
    const guard = new JwtAuthGuard(
      { verifyAsync } as unknown as JwtService,
      mockReflector(),
      mockPrisma(),
    );
    const { ctx } = contextFor({ authorization: 'Bearer bad.token' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  describe('subscription paywall', () => {
    it('status=active + subscription=active → allowed', async () => {
      const guard = new JwtAuthGuard(
        { verifyAsync } as unknown as JwtService,
        mockReflector(false),
        mockPrisma({ status: 'active', subscriptionStatus: 'active' }),
      );
      const { ctx } = contextFor({ authorization: 'Bearer t' });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('status=active + subscription=none → SUBSCRIPTION_REQUIRED', async () => {
      const guard = new JwtAuthGuard(
        { verifyAsync } as unknown as JwtService,
        mockReflector(false),
        mockPrisma({ status: 'active', subscriptionStatus: 'none' }),
      );
      const { ctx } = contextFor({ authorization: 'Bearer t' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
      try {
        await guard.canActivate(ctx);
      } catch (e: unknown) {
        const err = e as ForbiddenException;
        const resp = err.getResponse() as { code: string };
        expect(resp.code).toBe('SUBSCRIPTION_REQUIRED');
      }
    });

    it('status=active + subscription=past_due → blocked', async () => {
      const guard = new JwtAuthGuard(
        { verifyAsync } as unknown as JwtService,
        mockReflector(false),
        mockPrisma({ status: 'active', subscriptionStatus: 'past_due' }),
      );
      const { ctx } = contextFor({ authorization: 'Bearer t' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });

    it('status=active + subscription=canceled → blocked', async () => {
      const guard = new JwtAuthGuard(
        { verifyAsync } as unknown as JwtService,
        mockReflector(false),
        mockPrisma({ status: 'active', subscriptionStatus: 'canceled' }),
      );
      const { ctx } = contextFor({ authorization: 'Bearer t' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });

    it('status=pending → blocked (account not active)', async () => {
      const guard = new JwtAuthGuard(
        { verifyAsync } as unknown as JwtService,
        mockReflector(false),
        mockPrisma({ status: 'pending', subscriptionStatus: 'none' }),
      );
      const { ctx } = contextFor({ authorization: 'Bearer t' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });

    it('status=suspended → blocked even if subscription=active', async () => {
      const guard = new JwtAuthGuard(
        { verifyAsync } as unknown as JwtService,
        mockReflector(false),
        mockPrisma({ status: 'suspended', subscriptionStatus: 'active' }),
      );
      const { ctx } = contextFor({ authorization: 'Bearer t' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });

    it('@NoSubscriptionRequired() → allowed without subscription', async () => {
      const guard = new JwtAuthGuard(
        { verifyAsync } as unknown as JwtService,
        mockReflector(true),
        mockPrisma({ status: 'active', subscriptionStatus: 'none' }),
      );
      const { ctx } = contextFor({ authorization: 'Bearer t' });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('token without tenantId → skips subscription check', async () => {
      verifyAsync.mockResolvedValue({ sub: 'x', email: 'x@y.com' });
      const guard = new JwtAuthGuard(
        { verifyAsync } as unknown as JwtService,
        mockReflector(false),
        mockPrisma(),
      );
      const { ctx } = contextFor({ authorization: 'Bearer t' });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });
  });
});
