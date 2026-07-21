import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

// The admin "badge". Populated by the admin login (JWT) once it exists.
interface AdminRequest {
  user?: { tenantId?: string; isAdmin?: boolean };
  params?: { tenantId?: string };
  query?: { tenantId?: string };
}

/**
 * Route-level opt-out of the admin requirement on an AdminTenantGuard-protected
 * controller. The caller must still be an authenticated tenant user (JwtAuthGuard);
 * the route stays scoped to their own tenant via the verified token. Use for
 * SE-facing writes on an otherwise admin-only controller (e.g. reporting a gap).
 */
export const ALLOW_NON_ADMIN = 'allowNonAdmin';
export const AllowNonAdmin = () => SetMetadata(ALLOW_NON_ADMIN, true);

/**
 * Confirms the caller is an admin of the tenant they are trying to reach.
 *
 * Used on the allowlist routes (tenant id in the URL) and on /analytics/* (tenant
 * id in a query param). Rejecting a mismatch is what stops an admin of one tenant
 * from reaching another tenant's data by editing the id in the request — the id
 * is only trusted when it matches the admin's own badge.
 *
 * Routes marked @AllowNonAdmin() skip the admin check (still authenticated).
 */
@Injectable()
export class AdminTenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const user = req.user;

    const allowNonAdmin = this.reflector.getAllAndOverride<boolean>(
      ALLOW_NON_ADMIN,
      [context.getHandler(), context.getClass()],
    );
    if (allowNonAdmin) {
      // SE-facing route: any authenticated tenant user may call it. It stays
      // scoped to their own tenant via the JWT (never a request-supplied id).
      if (!user?.tenantId) {
        throw new ForbiddenException('Authentication required');
      }
      return true;
    }

    if (!user?.isAdmin || !user.tenantId) {
      throw new ForbiddenException('Admin authentication required');
    }

    const requested = req.params?.tenantId ?? req.query?.tenantId;
    if (requested && requested !== user.tenantId) {
      throw new ForbiddenException("Cannot access another tenant's data");
    }

    return true;
  }
}
