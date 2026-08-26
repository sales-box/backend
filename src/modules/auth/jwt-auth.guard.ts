import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import type { AdminJwtPayload } from './admin-auth.service';
import { PrismaService } from '@/database/prisma.service';
import {
  NO_SUBSCRIPTION_REQUIRED,
  assertSubscriptionActive,
} from '@/common/guards/assert-subscription-active';

/** Request enriched by JwtAuthGuard — tenant guards read req.user from here. */
export type AuthenticatedRequest = FastifyRequest & { user: AdminJwtPayload };

/**
 * Authentication layer: verifies the Bearer JWT and populates
 * req.user = { sub, tenantId, isAdmin, email }. Fail-closed (401).
 * Authorization (isAdmin / tenant match) belongs to the tenant guards
 * composed AFTER this one.
 *
 * It also enforces the paywall, which is a deliberate exception to that split.
 * SalesBox has no free tier, so "has this tenant paid" gates every product
 * route — and this guard is the one thing every tenant-facing controller
 * already has, whether it composes AdminTenantGuard (clients, analytics, crm,
 * allowlist) or stands alone (emails, knowledge-base, ai, external-content).
 * Enforcing it anywhere else means a new controller can ship without it and
 * silently give the product away; enforcing it here means a new controller is
 * paywalled by default and the only way out is an explicit
 * @NoSubscriptionRequired(), which greps.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

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

    const exempt = this.reflector.getAllAndOverride<boolean>(
      NO_SUBSCRIPTION_REQUIRED,
      [context.getHandler(), context.getClass()],
    );
    // A token without a tenantId cannot be checked against a subscription;
    // the tenant guards downstream reject it on their own terms.
    if (!exempt && req.user?.tenantId) {
      await assertSubscriptionActive(this.prisma, req.user.tenantId);
    }

    return true;
  }
}
