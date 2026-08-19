import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import {
  PLATFORM_JWT_ROLE,
  type PlatformJwtPayload,
} from './platform.constants';

/** Request enriched by PlatformGuard. Distinct from tenant `req.user`. */
export type AuthenticatedPlatformRequest = FastifyRequest & {
  platformAdmin: PlatformJwtPayload;
};

/**
 * Gate for the platform-operator console. The ONLY guard that lets a caller act
 * across tenants.
 *
 * - Missing / invalid / expired token → 401.
 * - A valid tenant token (verifies with the same secret, but carries no
 *   `role: 'platform'`) → 403. This is the boundary in one direction; the other
 *   direction (a platform token can't reach tenant routes) is enforced by the
 *   tenant guards, which require a tenantId a platform token never has.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<AuthenticatedPlatformRequest>();

    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: PlatformJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<PlatformJwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (payload?.role !== PLATFORM_JWT_ROLE) {
      throw new ForbiddenException('Not a platform operator token');
    }

    req.platformAdmin = payload;
    return true;
  }
}
