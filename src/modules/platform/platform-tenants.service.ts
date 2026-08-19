import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

const ACTIVE_SEAT_STATUSES = ['granted', 'verified'];

@Injectable()
export class PlatformTenantsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every tenant on the platform (operator view), paginated. Metadata only. */
  async list(page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [total, tenants] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.tenant.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: { id: true, companyName: true, status: true, tier: true },
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
