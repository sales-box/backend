import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';

function contextFor(headers: Record<string, string>): {
  ctx: ExecutionContext;
  req: { headers: Record<string, string>; user?: unknown };
} {
  const req: { headers: Record<string, string>; user?: unknown } = { headers };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

describe('JwtAuthGuard', () => {
  let verifyAsync: jest.Mock;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    verifyAsync = jest.fn();
    guard = new JwtAuthGuard({ verifyAsync } as unknown as JwtService);
  });

  it('populates req.user from a valid Bearer token', async () => {
    const claims = {
      sub: 'acc-1',
      tenantId: 'tenant-a',
      isAdmin: true,
      email: 'a@b.com',
    };
    verifyAsync.mockResolvedValue(claims);
    const { ctx, req } = contextFor({ authorization: 'Bearer good.token' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(verifyAsync).toHaveBeenCalledWith('good.token');
    expect(req.user).toEqual(claims);
  });

  it('rejects a missing Authorization header', async () => {
    const { ctx } = contextFor({});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a non-Bearer scheme', async () => {
    const { ctx } = contextFor({ authorization: 'Basic abc' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(verifyAsync).not.toHaveBeenCalled();
  });

  it('rejects an invalid/expired token', async () => {
    verifyAsync.mockRejectedValue(new Error('jwt expired'));
    const { ctx } = contextFor({ authorization: 'Bearer bad.token' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
