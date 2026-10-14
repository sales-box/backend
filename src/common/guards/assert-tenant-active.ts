import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@/database/prisma.service';

/**
 * Rejects a request whose owning tenant is not `active`.
 *
 * Called by the tenant guards so a platform-operator suspend/offboard blocks the
 * tenant's admin AND its SEs on their very next request — reversibly for
 * `suspended` (re-activating restores access), terminally for `offboarded`.
 * This is the tenant-level counterpart to the account-level `status` checks the
 * guards already do.
 */
export async function assertTenantActive(
  prisma: PrismaService,
  tenantId: string,
): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true },
  });
  if (!tenant || tenant.status !== 'active') {
    throw new ForbiddenException('This account is not active');
  }
}
