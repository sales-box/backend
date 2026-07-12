import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

// The admin "badge". Populated by the admin login (JWT) once it exists.
// TODO(coordinate with Salma): confirm the real JWT claim names (tenantId, isAdmin).
interface AdminRequest {
  user?: { tenantId?: string; isAdmin?: boolean };
  params?: { tenantId?: string };
  query?: { tenantId?: string };
}

/**
 * Confirms the caller is an admin of the tenant they are trying to reach.
 *
 * Used on the allowlist routes (tenant id in the URL) and on /analytics/* (tenant
 * id in a query param). Rejecting a mismatch is what stops an admin of one tenant
 * from reaching another tenant's data by editing the id in the request — the id
 * is only trusted when it matches the admin's own badge.
 */
@Injectable()
export class AdminTenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const user = req.user;

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
