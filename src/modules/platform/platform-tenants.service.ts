import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AllowlistService } from '../allowlist/allowlist.service';
import type { TenantStatusAction } from './dto/change-status.dto';

const ACTIVE_SEAT_STATUSES = ['granted', 'verified'];

export interface PlatformStats {
  total: number;
  byStatus: Record<TenantStatus, number>;
  byTier: Record<number, number>;
  newThisWeek: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** The only states a tenant may be permanently destroyed from. */
const DELETABLE_STATUSES: TenantStatus[] = ['offboarded', 'abandoned'];

@Injectable()
export class PlatformTenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly allowlist: AllowlistService,
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
    const where = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(search
        ? { companyName: { contains: search, mode: 'insensitive' as const } }
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
    await this.assertExists(id);
    return this.prisma.tenant.update({
      where: { id },
      data: { tier },
      select: { id: true, tier: true },
    });
  }

  /**
   * Permanently destroy a tenant and every row scoped to it. Irreversible.
   *
   * Gated on a terminal status: offboarding is the reversible-ish first act
   * that revokes access, this is the deliberate second one. An operator cannot
   * reach it from `active` or `suspended`.
   *
   * Every table is named explicitly rather than relying on `onDelete: Cascade`
   * because `interaction`, `crmConnection`, and `generalAnalysis` carry a
   * `tenantId` with no foreign key — a cascade would leave their rows behind,
   * still holding the customer's email content. The spec reads schema.prisma
   * and fails if this list ever falls behind.
   */
  async purge(id: string): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    if (!DELETABLE_STATUSES.includes(tenant.status)) {
      throw new ConflictException(
        `Only an offboarded tenant can be deleted — this one is '${tenant.status}'. Offboard it first.`,
      );
    }

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
      this.prisma.connectedAccount.deleteMany({ where }),
      this.prisma.client.deleteMany({ where }),
      this.prisma.tenant.delete({ where: { id } }),
    ]);
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

  private async assertExists(id: string): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
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
