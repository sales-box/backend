import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import type { AdminJwtPayload } from './admin-auth.service';

/** Request enriched by JwtAuthGuard — tenant guards read req.user from here. */
export type AuthenticatedRequest = FastifyRequest & { user: AdminJwtPayload };

/**
 * Authentication layer: verifies the Bearer JWT and populates
 * req.user = { sub, tenantId, isAdmin, email }. Fail-closed (401).
 * Authorization (isAdmin / tenant match) belongs to the tenant guards
 * composed AFTER this one.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      req.user = await this.jwt.verifyAsync<AdminJwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return true;
  }
}
