import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PlatformGuard } from './platform.guard';
import { PLATFORM_JWT_ROLE } from './platform.constants';

function contextWithAuth(header?: string): {
  ctx: ExecutionContext;
  req: Record<string, unknown>;
} {
  const req: Record<string, unknown> = {
    headers: header ? { authorization: header } : {},
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

describe('PlatformGuard', () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  const guard = new PlatformGuard(jwt);

  it('rejects a request with no bearer token (401)', async () => {
    const { ctx } = contextWithAuth();
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a garbage token (401)', async () => {
    const { ctx } = contextWithAuth('Bearer not-a-jwt');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a valid TENANT token that lacks the platform role (403)', async () => {
    const tenantToken = await jwt.signAsync({
      sub: 'ca-1',
      tenantId: 't-1',
      isAdmin: true,
      email: 'admin@acme.com',
    });
    const { ctx } = contextWithAuth(`Bearer ${tenantToken}`);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('accepts a platform token and attaches req.platformAdmin', async () => {
    const platformToken = await jwt.signAsync({
      sub: 'pa-1',
      role: PLATFORM_JWT_ROLE,
      email: 'ops@salesbox.dev',
    });
    const { ctx, req } = contextWithAuth(`Bearer ${platformToken}`);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    const attached = req.platformAdmin as Record<string, unknown>;
    expect(attached.role).toBe(PLATFORM_JWT_ROLE);
    expect(attached.email).toBe('ops@salesbox.dev');
    expect(attached.tenantId).toBeUndefined();
  });
});
