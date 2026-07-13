import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { EmailNotifyService } from '../email-notify/email-notify.service';

// The three states an allowlist entry moves through (see schema comment).
const GRANTED = 'granted';
const VERIFIED = 'verified';
const REVOKED = 'revoked';

// How many Sales Engineers each plan tier may have active at once.
// TODO(pricing): confirm the real caps with Abdulrahman / product.
const TIER_SE_LIMITS: Record<number, number> = { 1: 3, 2: 10, 3: 50 };
const DEFAULT_SE_LIMIT = 3;

@Injectable()
export class AllowlistService {
  private readonly logger = new Logger(AllowlistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailNotifyService,
  ) {}

  /**
   * Admin adds an SE to the tenant's allowlist. Rejects if the tenant is already
   * at its plan tier's SE cap, then records the entry as granted and emails the
   * SE the extension install link.
   *
   * Accepts an optional Prisma transaction client so it can run atomically inside
   * another operation (e.g. tenant activation grants the admin's own email).
   *
   * @param skipInvite - When true, suppresses the SE-branded invite email.
   *   Pass true during tenant activation so the admin does not receive
   *   "install the extension" copy meant for Sales Engineers.
   *   Defaults to false; existing call sites need no change.
   */
  async grantAccess(
    tenantId: string,
    email: string,
    tx?: Prisma.TransactionClient,
    skipInvite = false,
  ): Promise<void> {
    const db = tx ?? this.prisma;

    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    // Only active (granted/verified) entries count toward the plan cap.
    const activeCount = await db.allowlistEntry.count({
      where: { tenantId, status: { in: [GRANTED, VERIFIED] } },
    });
    const limit = TIER_SE_LIMITS[tenant.tier] ?? DEFAULT_SE_LIMIT;
    if (activeCount >= limit) {
      throw new ForbiddenException(
        `Tenant is at its plan limit of ${limit} sales engineers`,
      );
    }

    // Add the entry, or re-activate a previously revoked one.
    await db.allowlistEntry.upsert({
      where: { tenantId_email: { tenantId, email } },
      create: { tenantId, email, status: GRANTED },
      update: { status: GRANTED, grantedAt: new Date(), revokedAt: null },
    });

    // Side effect after the row is written; never fails the grant.
    // skipInvite=true when called from tenant activation (admin self-grant);
    // the SE-branded "install the extension" copy is wrong in that context.
    if (!skipInvite) {
      await this.email.sendSeInvite(email);
    }
    this.logger.log(`Granted access to ${email} on tenant ${tenantId}`);
  }

  /**
   * Called during OAuth (AuthService.handleGoogleCallback and SE login). If the
   * email is not on any tenant's allowlist as granted/verified, the sign-in is
   * rejected even though Google approved the permissions. Otherwise the entry is
   * marked verified so we know this account has completed the badge-in.
   *
   * Returns the tenant the email was granted under, so the caller can stamp it
   * onto the ConnectedAccount + JWT. This is what makes revokeAccess/offboard
   * (which match the live account by tenantId + email) actually reach an SE's
   * account, and gives SE tokens a real tenant before DEP-1 lands.
   */
  async verifyAccess(email: string): Promise<{ tenantId: string }> {
    const entry = await this.prisma.allowlistEntry.findFirst({
      where: { email, status: { in: [GRANTED, VERIFIED] } },
    });

    if (!entry) {
      throw new ForbiddenException('This email is not on any allowlist');
    }

    if (entry.status !== VERIFIED) {
      await this.prisma.allowlistEntry.update({
        where: { id: entry.id },
        data: { status: VERIFIED, verifiedAt: new Date() },
      });
    }

    return { tenantId: entry.tenantId };
  }

  /**
   * Cuts off one SE immediately. Flips BOTH the allowlist entry and the live
   * ConnectedAccount to revoked in a single transaction — so access is gone
   * right now, not whenever the OAuth token happens to expire on its own.
   */
  async revokeAccess(tenantId: string, email: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.allowlistEntry.updateMany({
        where: { tenantId, email },
        data: { status: REVOKED, revokedAt: new Date() },
      }),
      this.prisma.connectedAccount.updateMany({
        where: { tenantId, email },
        data: { status: REVOKED },
      }),
    ]);
    this.logger.log(`Revoked access for ${email} on tenant ${tenantId}`);
  }

  /**
   * Offboards a whole tenant: revokes EVERY allowlist entry and EVERY connected
   * account for the tenant, then marks the tenant offboarded — all in one
   * transaction. No client data is deleted; it simply becomes unreachable
   * because every account that could sign in is locked.
   */
  async offboardTenant(tenantId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.allowlistEntry.updateMany({
        where: { tenantId },
        data: { status: REVOKED, revokedAt: new Date() },
      }),
      this.prisma.connectedAccount.updateMany({
        where: { tenantId },
        data: { status: REVOKED },
      }),
      this.prisma.tenant.update({
        where: { id: tenantId },
        data: { status: 'offboarded' },
      }),
    ]);
    this.logger.log(`Offboarded tenant ${tenantId}`);
  }

  /** Lists a tenant's SEs for the team-management dashboard. */
  async listAllowlist(tenantId: string) {
    return this.prisma.allowlistEntry.findMany({
      where: { tenantId },
      select: {
        email: true,
        status: true,
        grantedAt: true,
        verifiedAt: true,
        revokedAt: true,
      },
      orderBy: { grantedAt: 'desc' },
    });
  }
}
