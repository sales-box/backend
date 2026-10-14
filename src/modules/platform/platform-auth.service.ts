import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { verify } from '@node-rs/argon2';
import { PrismaService } from '../../database/prisma.service';
import {
  PLATFORM_JWT_ROLE,
  type PlatformJwtPayload,
} from './platform.constants';

@Injectable()
export class PlatformAuthService {
  private readonly logger = new Logger(PlatformAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Email + password login for a platform operator.
   * Every failure is the same generic 401 — no user enumeration.
   * On success, stamps lastLoginAt and returns a platform JWT (role: 'platform',
   * no tenantId).
   */
  async login(email: string, password: string): Promise<{ token: string }> {
    const normalized = email.trim().toLowerCase();

    const admin = await this.prisma.platformAdmin.findUnique({
      where: { email: normalized },
    });
    if (!admin) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await verify(admin.passwordHash, password).catch(() => false);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.platformAdmin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    const payload: PlatformJwtPayload = {
      sub: admin.id,
      role: PLATFORM_JWT_ROLE,
      email: admin.email,
    };
    this.logger.log(`Platform admin login: ${normalized}`);
    return { token: await this.jwt.signAsync({ ...payload }) };
  }
}
