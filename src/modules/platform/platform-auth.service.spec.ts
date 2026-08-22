import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash } from '@node-rs/argon2';
import { PlatformAuthService } from './platform-auth.service';
import { PLATFORM_JWT_ROLE } from './platform.constants';
import type { PrismaService } from '../../database/prisma.service';

describe('PlatformAuthService.login', () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await hash('correct-horse', {
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  });

  function makeService(
    admin: { id: string; email: string; passwordHash: string } | null,
  ) {
    const findUnique = jest.fn().mockResolvedValue(admin);
    const update = jest.fn().mockResolvedValue(admin);
    const prisma = {
      platformAdmin: { findUnique, update },
    } as unknown as PrismaService;
    return {
      service: new PlatformAuthService(prisma, jwt),
      findUnique,
      update,
    };
  }

  it('rejects an unknown email with a generic 401', async () => {
    const { service } = makeService(null);
    await expect(
      service.login('nobody@x.com', 'whatever'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong password with a generic 401', async () => {
    const { service } = makeService({
      id: 'pa-1',
      email: 'ops@salesbox.dev',
      passwordHash,
    });
    await expect(
      service.login('ops@salesbox.dev', 'wrong-password'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns a platform token (role=platform, no tenantId) and stamps lastLoginAt', async () => {
    const { service, findUnique, update } = makeService({
      id: 'pa-1',
      email: 'ops@salesbox.dev',
      passwordHash,
    });

    const { token } = await service.login(
      '  OPS@Salesbox.dev  ',
      'correct-horse',
    );

    // Email was normalized before the lookup.
    expect(findUnique).toHaveBeenCalledWith({
      where: { email: 'ops@salesbox.dev' },
    });
    // lastLoginAt was stamped.
    expect(update).toHaveBeenCalledTimes(1);

    const payload = jwt.verify<Record<string, unknown>>(token);
    expect(payload.role).toBe(PLATFORM_JWT_ROLE);
    expect(payload.sub).toBe('pa-1');
    expect(payload.tenantId).toBeUndefined();
  });
});
