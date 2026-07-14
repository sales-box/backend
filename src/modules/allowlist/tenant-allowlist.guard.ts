import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AdminJwtPayload } from '../auth/admin-auth.service';
import { PrismaService } from '@/database/prisma.service';

interface SeRequest {
  headers: { authorization?: string };
  user?: AdminJwtPayload;
}

/**
 * Protects endpoints the Gmail extension calls: verifies the SE's JWT (through
 * the shared JwtService, same engine and secret as every other token) and
 * confirms their ConnectedAccount is still `connected`. A revoked account is cut
 * off immediately here — even if the token itself has not expired yet — which is
 * what makes revokeAccess/offboard take effect instantly.
 */
@Injectable()
export class TenantAllowlistGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<SeRequest>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: AdminJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<AdminJwtPayload>(token);
      if (!payload.email) {
        throw new Error('token has no email claim');
      }
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    // Scope the lookup by BOTH tenantId and email (from the verified JWT) so a
    // revoked account at tenant A cannot be validated against a ConnectedAccount
    // row that was later re-assigned to tenant B with the same email address.
    const account = await this.prisma.connectedAccount.findFirst({
      where: {
        email: payload.email,
        status: 'connected',
        ...(payload.tenantId ? { tenantId: payload.tenantId } : {}),
      },
    });
    if (!account) {
      throw new UnauthorizedException('Account is not connected');
    }

    // Expose the verified claims to handlers, same contract as JwtAuthGuard.
    req.user = payload;
    return true;
  }
}
