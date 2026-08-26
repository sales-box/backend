import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TenantStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AllowlistService } from '../allowlist/allowlist.service';
import { CryptoService } from '../auth/crypto.service';
import type { TenantStatusAction } from './dto/change-status.dto';

const ACTIVE_SEAT_STATUSES = ['granted', 'verified'];

/** A closed workspace's plan is frozen — there is nothing left to bill for. */
const TERMINAL_STATUSES: TenantStatus[] = ['offboarded', 'abandoned'];

export interface PlatformStats {
  total: number;
  byStatus: Record<TenantStatus, number>;
  byTier: Record<number, number>;
  newThisWeek: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class PlatformTenantsService {
  private readonly logger = new Logger(PlatformTenantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allowlist: AllowlistService,
    private readonly crypto: CryptoService,
  ) {}

  /** Every tenant on the platform (operator view), paginated. Metadata only. */
  async list(
    page: number,
    limit: number,
    filters: { search?: string; status?: TenantStatus } = {},
  ) {
    const skip = (page - 1) * limit;
    const search = filters.search?.trim();
    // Built once and reused for both queries — a count taken without the same
    // filter would produce page numbers that do not match the rows on screen.
    const where: Prisma.TenantWhereInput = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(search
        ? { companyName: { contains: search, mode: 'insensitive' } }
        : {}),
    };

    const [total, tenants] = await Promise.all([
      this.prisma.tenant.count({ where }),
      this.prisma.tenant.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          companyName: true,
          status: true,
          tier: true,
          createdAt: true,
        },
      }),
    ]);

    const seatCounts = await this.seatCounts(tenants.map((t) => t.id));
    const lastPage = Math.ceil(total / limit);
    return {
      data: tenants.map((t) => ({ ...t, seCount: seatCounts.get(t.id) ?? 0 })),
      meta: {
        total,
        lastPage,
        currentPage: page,
        limit,
        prev: page > 1 ? page - 1 : null,
        next: page < lastPage ? page + 1 : null,
      },
    };
  }

  /**
   * Platform-wide tenant counts for the operator overview.
   *
   * Every bucket key is present with a zero default: a status with no tenants
   * simply does not come back from `groupBy`, and the console renders a "0"
   * tile rather than a blank one.
   */
  async stats(): Promise<PlatformStats> {
    const since = new Date(Date.now() - SEVEN_DAYS_MS);
    const [statusRows, tierRows, total, newThisWeek] = await Promise.all([
      this.prisma.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.tenant.groupBy({ by: ['tier'], _count: { _all: true } }),
      this.prisma.tenant.count(),
      this.prisma.tenant.count({ where: { createdAt: { gte: since } } }),
    ]);

    const byStatus: Record<TenantStatus, number> = {
      pending: 0,
      active: 0,
      suspended: 0,
      abandoned: 0,
      offboarded: 0,
    };
    for (const row of statusRows) {
      byStatus[row.status] = row._count._all;
    }

    const byTier: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    for (const row of tierRows) {
      byTier[row.tier] = row._count._all;
    }

    return { total, byStatus, byTier, newThisWeek };
  }

  /** One tenant's operational detail. Still metadata only — no business data. */
  async getDetail(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: {
        id: true,
        companyName: true,
        status: true,
        tier: true,
        createdAt: true,
      },
    });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const [seCount, docCount, emailCount, activity] = await Promise.all([
      this.prisma.allowlistEntry.count({
        where: { tenantId: id, status: { in: ACTIVE_SEAT_STATUSES } },
      }),
      this.prisma.document.count({ where: { tenantId: id } }),
      this.prisma.generalAnalysis.count({ where: { tenantId: id } }),
      this.prisma.connectedAccount.aggregate({
        where: { tenantId: id },
        _max: { lastLoginAt: true },
      }),
    ]);

    return {
      ...tenant,
      seCount,
      docCount,
      emailCount,
      lastActivityAt: activity._max.lastLoginAt,
    };
  }

  /** Suspend / reactivate / offboard a tenant, enforcing the transition matrix. */
  async changeStatus(id: string, action: TenantStatusAction) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    switch (action) {
      case 'suspend':
        this.assertTransition(tenant.status, ['active'], action);
        return this.setStatus(id, 'suspended');
      case 'activate':
        this.assertTransition(tenant.status, ['suspended'], action);
        return this.setStatus(id, 'active');
      case 'offboard':
        this.assertTransition(tenant.status, ['active', 'suspended'], action);
        // Existing terminal path: revokes every account, sets status=offboarded.
        await this.allowlist.offboardTenant(id);
        return { id, status: 'offboarded' as const };
    }
  }

  /** Set a tenant's plan tier (operator override; not a billing charge). */
  async changeTier(id: string, tier: number) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    // The console disables this control for a closed workspace; enforce it
    // here too, because a UI-only check is not a check.
    if (TERMINAL_STATUSES.includes(tenant.status)) {
      throw new ConflictException(
        `Cannot change the plan of a tenant that is '${tenant.status}'`,
      );
    }
    return this.prisma.tenant.update({
      where: { id },
      data: { tier },
      select: { id: true, tier: true },
    });
  }

  /**
   * Permanently destroy a tenant and every row scoped to it. Irreversible.
   *
   * Gated on a terminal status: offboarding revokes access and is the
   * deliberate first act; this is the second. An operator cannot reach it from
   * `active` or `suspended`.
   *
   * Every table is named explicitly rather than relying on `onDelete`. Six of
   * the tenant foreign keys are ON DELETE SET NULL, so a table left out of this
   * list is NOT protected by the database — its rows would silently survive
   * with `tenant_id = NULL` while this endpoint returned 204. Three tables
   * (interaction, crm_connections, general_analysis) carry a tenantId with no
   * foreign key at all. The spec reads schema.prisma and fails if this list
   * ever falls behind.
   */
  async purge(id: string): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    if (!TERMINAL_STATUSES.includes(tenant.status)) {
      throw new ConflictException(
        `Only an offboarded tenant can be deleted — this one is '${tenant.status}'. Offboard it first.`,
      );
    }

    // Read the mailboxes BEFORE deleting: processed_gmail_messages has no
    // tenantId (only accountEmail), and the Google grants can only be revoked
    // while we still hold the refresh tokens.
    const accounts = await this.prisma.connectedAccount.findMany({
      where: { tenantId: id },
      select: { email: true, refreshToken: true },
    });
    const emails = accounts.map((a) => a.email);

    await this.revokeGoogleGrants(accounts, id);

    const where = { tenantId: id };
    await this.prisma.$transaction([
      // Dependants first, tenant last.
      this.prisma.interaction.deleteMany({ where }),
      this.prisma.escalationItem.deleteMany({ where }),
      this.prisma.generalAnalysis.deleteMany({ where }),
      this.prisma.knowledgeGap.deleteMany({ where }),
      this.prisma.document.deleteMany({ where }),
      this.prisma.crmConnection.deleteMany({ where }),
      this.prisma.crmAgentConnection.deleteMany({ where }),
      this.prisma.driveConnection.deleteMany({ where }),
      this.prisma.allowedDomain.deleteMany({ where }),
      this.prisma.allowlistEntry.deleteMany({ where }),
      // Keyed by accountEmail, not tenantId — it would otherwise outlive the
      // tenant as a permanent ledger of its users' addresses and message ids.
      this.prisma.processedGmailMessage.deleteMany({
        where: { accountEmail: { in: emails } },
      }),
      this.prisma.connectedAccount.deleteMany({ where }),
      this.prisma.client.deleteMany({ where }),
      this.prisma.tenant.delete({ where: { id } }),
    ]);

    this.logger.warn(
      `Tenant ${id} permanently deleted (${emails.length} mailbox(es))`,
    );
  }

  /**
   * Best-effort revocation of each mailbox's Google grant.
   *
   * Deleting our copy of a refresh token does not invalidate it — the grant
   * stays live in the customer's Google account, and once the row is gone we no
   * longer know which grant to revoke. Failures are logged and do not abort the
   * purge: a tenant that cannot be deleted because Google is briefly
   * unreachable would be worse than a grant that needs manual cleanup.
   */
  private async revokeGoogleGrants(
    accounts: Array<{ email: string; refreshToken: string | null }>,
    tenantId: string,
  ): Promise<void> {
    for (const account of accounts) {
      if (!account.refreshToken) continue;
      try {
        const token = this.crypto.decrypt(account.refreshToken);
        const res = await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
        });
        if (!res.ok) {
          this.logger.error(
            `Google revoke returned ${res.status} for a mailbox of tenant ${tenantId}; the grant may still be live`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Google revoke failed for a mailbox of tenant ${tenantId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private assertTransition(
    current: string,
    allowedFrom: string[],
    action: TenantStatusAction,
  ): void {
    if (!allowedFrom.includes(current)) {
      throw new ConflictException(
        `Cannot ${action} a tenant that is '${current}'`,
      );
    }
  }

  private setStatus(id: string, status: 'active' | 'suspended') {
    return this.prisma.tenant.update({
      where: { id },
      data: { status },
      select: { id: true, status: true },
    });
  }

  /** Active-seat (granted|verified) counts for the given tenants, in one query. */
  private async seatCounts(tenantIds: string[]): Promise<Map<string, number>> {
    if (tenantIds.length === 0) return new Map();
    const groups = await this.prisma.allowlistEntry.groupBy({
      by: ['tenantId'],
      where: {
        tenantId: { in: tenantIds },
        status: { in: ACTIVE_SEAT_STATUSES },
      },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.tenantId, g._count._all]));
  }
}
