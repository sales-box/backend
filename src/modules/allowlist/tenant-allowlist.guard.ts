import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '@/database/prisma.service';

interface SeRequest {
  headers: { authorization?: string };
}

/**
 * Protects endpoints the Gmail extension calls: verifies the SE's JWT and
 * confirms their ConnectedAccount is still `connected`. A revoked account is cut
 * off immediately here — even if the token itself has not expired yet — which is
 * what makes revokeAccess/offboard take effect instantly.
 */
@Injectable()
export class TenantAllowlistGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<SeRequest>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let email: string;
    try {
      const payload = jwt.verify(
        token,
        this.config.getOrThrow<string>('JWT_SECRET'),
      ) as { email?: string };
      if (!payload.email) {
        throw new Error('token has no email claim');
      }
      email = payload.email;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    const account = await this.prisma.connectedAccount.findFirst({
      where: { email, status: 'connected' },
    });
    if (!account) {
      throw new UnauthorizedException('Account is not connected');
    }
    return true;
  }
}
