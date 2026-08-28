import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SubscriptionStatus, TenantStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AllowlistService } from '../allowlist/allowlist.service';
import { GoogleGrantRevoker } from './google-grant-revoker';
import type { TenantStatusAction } from './dto/change-status.dto';

const ACTIVE_SEAT_STATUSES = ['granted', 'verified'];

/** A closed workspace's plan is frozen — there is nothing left to bill for. */
const TERMINAL_STATUSES: TenantStatus[] = ['offboarded', 'abandoned'];

/** One UTC day of the platform trend chart. */
export interface TrendPoint {
  /** YYYY-MM-DD, UTC. */
  date: string;
  signups: number;
  emailsAnalysed: number;
}

export interface PlatformStats {
  total: number;
  byStatus: Record<TenantStatus, number>;
  byTier: Record<number, number>;
  newThisWeek: number;
  /** Platform-wide volume. Tenant counts alone say nothing about usage. */
  usage: { seats: number; documents: number; emailsAnalysed: number };
  /**
   * Who is actually paying. Tier is NOT this — an unpaid tenant carries a tier
   * number too, so a console that shows only tier reports revenue that does
   * not exist.
   */
  billing: Record<SubscriptionStatus, number>;
  trend: TrendPoint[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const TREND_DAYS = 30;

/** Raw shape of the per-day rollup queries. */
interface DailyCount {
  day: string;
  count: number;
}

@Injectable()
export class PlatformTenantsService {
  private readonly logger = new Logger(PlatformTenantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allowlist: AllowlistService,
    private readonly revoker: GoogleGrantRevoker,
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
   * The operator overview: tenant mix, real usage volume, revenue mix, and a
   * 30-day trend.
   *
   * Every bucket key is present with a zero default: a status with no tenants
   * simply does not come back from `groupBy`, and the console renders a "0"
   * tile rather than a blank one.
   */
  async stats(): Promise<PlatformStats> {
    const since = new Date(Date.now() - SEVEN_DAYS_MS);
    const [
      statusRows,
      tierRows,
      billingRows,
      total,
      newThisWeek,
      seats,
      documents,
      emailsAnalysed,
      trend,
    ] = await Promise.all([
      this.prisma.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.tenant.groupBy({ by: ['tier'], _count: { _all: true } }),
      this.prisma.tenant.groupBy({
        by: ['subscriptionStatus'],
        _count: { _all: true },
      }),
      this.prisma.tenant.count(),
      this.prisma.tenant.count({ where: { createdAt: { gte: since } } }),
      this.prisma.allowlistEntry.count({
        where: { status: { in: ACTIVE_SEAT_STATUSES } },
      }),
      this.prisma.document.count(),
      this.prisma.generalAnalysis.count(),
      this.trend(),
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

    const billing: Record<SubscriptionStatus, number> = {
      none: 0,
      active: 0,
      past_due: 0,
      canceled: 0,
    };
    for (const row of billingRows) {
      billing[row.subscriptionStatus] = row._count._all;
    }

    return {
      total,
      byStatus,
      byTier,
      newThisWeek,
      usage: { seats, documents, emailsAnalysed },
      billing,
      trend,
    };
  }

  /**
   * Signups and analysed emails per UTC day for the last 30 days, including the
   * days on which nothing happened — a chart that silently skips empty days
   * draws a flat busy line over a quiet month.
   */
  private async trend(): Promise<TrendPoint[]> {
    const first = new Date(
      Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate(),
      ) -
        (TREND_DAYS - 1) * DAY_MS,
    );
    const sinceIso = first.toISOString();

    // The two `created_at` columns have DIFFERENT types, so they need different
    // SQL to land on the same UTC day. `tenants.created_at` is a naive
    // `timestamp` that Prisma already writes in UTC — truncating it directly is
    // correct, and an `AT TIME ZONE` would shift it. `general_analysis.
    // created_at` is `timestamptz`, so it must be converted to UTC first or
    // `date_trunc` would use the database server's timezone.
    const [signupRows, emailRows] = await Promise.all([
      this.prisma.$queryRaw<DailyCount[]>`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS count
        FROM tenants
        WHERE created_at >= ${sinceIso}::timestamp
        GROUP BY 1`,
      this.prisma.$queryRaw<DailyCount[]>`
        SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS count
        FROM general_analysis
        WHERE created_at >= ${sinceIso}::timestamptz
        GROUP BY 1`,
    ]);

    const signups = new Map(signupRows.map((r) => [r.day, r.count]));
    const emails = new Map(emailRows.map((r) => [r.day, r.count]));

    return Array.from({ length: TREND_DAYS }, (_, i) => {
      const date = new Date(first.getTime() + i * DAY_MS)
        .toISOString()
        .slice(0, 10);
      return {
        date,
        signups: signups.get(date) ?? 0,
        emailsAnalysed: emails.get(date) ?? 0,
      };
    });
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

    await this.revoker.revokeAll(accounts, `tenant ${id}`);

    const where = { tenantId: id };
    await this.prisma.$transaction([
      // Dependants first, tenant last.
      this.prisma.interaction.deleteMany({ where }),
      this.prisma.escalationItem.deleteMany({ where }),
      this.prisma.generalAnalysis.deleteMany({ where }),
      this.prisma.knowledgeGap.deleteMany({ where }),
      this.prisma.document.deleteMany({ where }),
      this.prisma.faqItem.deleteMany({ where }),
      this.prisma.faqDocument.deleteMany({ where }),
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
