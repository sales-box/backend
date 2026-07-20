import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma, KnowledgeGap } from '@prisma/client';
import { AnalyticsSummary, TeamMemberStats } from './types/analytics.types';
import { ActivityFeedQueryDto } from './dto/activity-feed-query.dto';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getAnalyticsSummary(
    days: number,
    tenantId: string,
  ): Promise<AnalyticsSummary> {
    if (!Number.isFinite(days) || days <= 0) {
      throw new BadRequestException('days must be a positive number');
    }
    // tenantId is REQUIRED — the summary is per-tenant. An omitted tenant is a
    // caller bug, never a query that silently aggregates across tenants.
    // AdminTenantGuard guarantees it upstream; this is defense in depth.
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }

    try {
      const dayMs = 86_400_000;
      const now = Date.now();
      const curStart = new Date(now - days * dayMs);
      const prevStart = new Date(now - 2 * days * dayMs);

      // Source of truth = general_analysis: one row per classified inbound
      // email with a direct tenant_id (no join through client). Interaction is
      // the per-client timeline, not the processed-email ledger.
      const cur = { tenantId, createdAt: { gte: curStart } };
      const aiReviewedWhere = { ...cur, supervisorLabel: { not: null } };

      const [
        total,
        prevTotal,
        byIntentRaw,
        replyThreadRows,
        aiReviewedCount,
        escalatedCount,
        confidenceStats,
        dailyCounts,
      ] = await Promise.all([
        this.prisma.generalAnalysis.count({ where: cur }),
        this.prisma.generalAnalysis.count({
          where: { tenantId, createdAt: { gte: prevStart, lt: curStart } },
        }),
        this.prisma.generalAnalysis.groupBy({
          by: ['intent'],
          where: cur,
          _count: { intent: true },
        }),
        // Replies counted per DISTINCT thread: reviewedAt is stamped on every
        // un-reviewed row of a thread when ONE sent message is detected, so
        // counting rows would multiply a single reply by the thread size.
        this.prisma.generalAnalysis.findMany({
          where: { ...cur, reviewedAt: { not: null } },
          select: { threadId: true },
          distinct: ['threadId'],
        }),
        this.prisma.generalAnalysis.count({ where: aiReviewedWhere }),
        // supervisorLabel is persisted as 'green' | 'yellow' | 'red' (the
        // orchestrator maps computeLabel's enum before saving). 'red' is the
        // escalate-to-human band.
        this.prisma.generalAnalysis.count({
          where: { ...cur, supervisorLabel: 'red' },
        }),
        // Confidence is written only for emails an SE opened via /ai/process,
        // so average over the AI-reviewed subset — never over all rows, whose
        // NULLs would silently skew it.
        this.prisma.generalAnalysis.aggregate({
          where: aiReviewedWhere,
          _avg: { productConfidence: true, clientHistoryConfidence: true },
        }),
        this.getDailyCounts(tenantId, curStart, days),
      ]);

      const byClassification: Record<string, number> = {};
      for (const row of byIntentRaw) {
        byClassification[row.intent] = row._count.intent;
      }

      let averageConfidence = 0;
      const avgProd = confidenceStats._avg.productConfidence;
      const avgHist = confidenceStats._avg.clientHistoryConfidence;
      if (avgProd !== null && avgHist !== null) {
        averageConfidence = (avgProd + avgHist) / 2;
      } else if (avgProd !== null) {
        averageConfidence = avgProd;
      } else if (avgHist !== null) {
        averageConfidence = avgHist;
      }

      const repliedThreads = replyThreadRows.filter(
        (r) => r.threadId !== null,
      ).length;

      const momChangePct =
        prevTotal > 0
          ? Math.round(((total - prevTotal) / prevTotal) * 100)
          : null;

      return {
        totalEmailsProcessed: total,
        byClassification,
        averageConfidence,
        lowConfidenceCount: escalatedCount, // back-compat: old FE reads this
        momChangePct,
        dailyCounts,
        replies: { threads: repliedThreads },
        aiReviewed: { count: aiReviewedCount, escalated: escalatedCount },
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error('Failed to compute analytics summary', error);
      throw new InternalServerErrorException(
        'Could not compute analytics summary',
      );
    }
  }

  /**
   * Real per-day email volume over the window, bucketed by UTC calendar day
   * and ZERO-FILLED so the chart spans the whole window with honest gaps
   * instead of interpolating over missing days.
   */
  private async getDailyCounts(
    tenantId: string,
    since: Date,
    days: number,
  ): Promise<{ date: string; emails: number }[]> {
    const rows = await this.prisma.$queryRaw<{ day: Date; emails: number }[]>`
      SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS emails
      FROM general_analysis
      WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${since}
      GROUP BY 1
      ORDER BY 1
    `;
    const byDay = new Map<string, number>();
    for (const r of rows) {
      byDay.set(new Date(r.day).toISOString().slice(0, 10), Number(r.emails));
    }
    const startDay = Date.UTC(
      since.getUTCFullYear(),
      since.getUTCMonth(),
      since.getUTCDate(),
    );
    const out: { date: string; emails: number }[] = [];
    for (let i = 0; i <= days; i++) {
      const key = new Date(startDay + i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      out.push({ date: key.slice(5), emails: byDay.get(key) ?? 0 });
    }
    return out;
  }

  /**
   * Per-SE activity for the tenant's Team/Analytics pages.
   *
   * tenantId is REQUIRED here (unlike getAnalyticsSummary's optional param,
   * which is a legacy accommodation for pre-multi-tenant rows). This method
   * has no legitimate "all tenants" mode — a missing tenantId must be a
   * compile error, not a query that silently falls back to `where: {}` and
   * returns every tenant's SE stats. Every call site is the AnalyticsController,
   * which only ever passes req.user.tenantId! after AdminTenantGuard has
   * already confirmed it's non-null — never a client-suppliable value.
   */
  async getTeamStats(tenantId: string): Promise<TeamMemberStats[]> {
    // Defense in depth: the type system says tenantId is required, but a
    // future caller could still pass an empty string. Empty string is
    // falsy but NOT the same as "field omitted" to Prisma's `where` —
    // catch it explicitly rather than letting `where: { tenantId: '' }`
    // quietly return zero rows and look like "this tenant has no team"
    // instead of the caller bug it actually is.
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    try {
      const [allowlistEntries, connectedAccounts, receivedGroups, sentGroups] =
        await Promise.all([
          this.prisma.allowlistEntry.findMany({
            where: { tenantId },
            select: {
              email: true,
              status: true,
              grantedAt: true,
              verifiedAt: true,
            },
            orderBy: { grantedAt: 'desc' },
          }),
          this.prisma.connectedAccount.findMany({
            where: { tenantId },
            select: { email: true, lastLoginAt: true },
          }),
          // emailsReceived: every GeneralAnalysis row is scoped to a single
          // account+tenant at write time (classifier.processor.ts), so
          // grouping by accountEmail here can never mix another tenant's rows in.
          this.prisma.generalAnalysis.groupBy({
            by: ['accountEmail'],
            where: { tenantId },
            _count: { _all: true },
          }),
          // repliesSent: same scope, plus reviewedAt IS NOT NULL — stamped
          // only when the Gmail history diff confirms an actual SENT message
          // on the thread, never on the SE merely opening the email.
          this.prisma.generalAnalysis.groupBy({
            by: ['accountEmail'],
            where: { tenantId, reviewedAt: { not: null } },
            _count: { _all: true },
          }),
        ]);

      // All three sources write lowercased/trimmed emails at their own write
      // sites (AllowlistService.grantAccess, AuthService.upsertConnectedAccount,
      // classifier.processor.ts's `account.email` which itself came from a
      // ConnectedAccount row) — so a plain-string map key is safe here without
      // re-normalizing.
      const lastLoginByEmail = new Map(
        connectedAccounts.map((a) => [a.email, a.lastLoginAt]),
      );
      const receivedByEmail = new Map(
        receivedGroups.map((g) => [g.accountEmail, g._count._all]),
      );
      const sentByEmail = new Map(
        sentGroups.map((g) => [g.accountEmail, g._count._all]),
      );

      return allowlistEntries.map((entry) => {
        const emailsReceived = receivedByEmail.get(entry.email) ?? 0;
        const repliesSent = sentByEmail.get(entry.email) ?? 0;
        return {
          email: entry.email,
          status: entry.status,
          grantedAt: entry.grantedAt,
          verifiedAt: entry.verifiedAt,
          lastLoginAt: lastLoginByEmail.get(entry.email) ?? null,
          emailsReceived,
          repliesSent,
          // Guard divide-by-zero explicitly rather than relying on NaN
          // happening to render as something reasonable downstream.
          replyRate: emailsReceived > 0 ? repliesSent / emailsReceived : 0,
        };
      });
    } catch (error) {
      this.logger.error(
        `Failed to compute team stats for tenant ${tenantId}`,
        error,
      );
      throw new InternalServerErrorException('Could not compute team stats');
    }
  }

  async upsertKnowledgeGap(
    topic: string,
    tenantId?: string,
  ): Promise<KnowledgeGap> {
    const normalizedTopic = topic.trim().toLowerCase();

    if (!normalizedTopic) {
      throw new BadRequestException('Topic cannot be empty');
    }

    try {
      // Gaps are unique per (tenantId, topic): the same topic for two
      // different companies stays two separate rows with separate counts.
      if (tenantId) {
        return await this.prisma.knowledgeGap.upsert({
          where: { tenantId_topic: { tenantId, topic: normalizedTopic } },
          update: { occurrences: { increment: 1 }, resolved: false },
          create: {
            topic: normalizedTopic,
            tenantId,
            occurrences: 1,
            resolved: false,
          },
        });
      }

      // Legacy rows have tenantId NULL, which a compound unique cannot
      // address in Prisma — emulate the upsert for that case.
      const existing = await this.prisma.knowledgeGap.findFirst({
        where: { topic: normalizedTopic, tenantId: null },
      });
      if (existing) {
        return await this.prisma.knowledgeGap.update({
          where: { id: existing.id },
          data: { occurrences: { increment: 1 }, resolved: false },
        });
      }
      return await this.prisma.knowledgeGap.create({
        data: { topic: normalizedTopic, occurrences: 1, resolved: false },
      });
    } catch (error) {
      this.logger.error(
        `Failed to upsert knowledge gap for topic: ${topic}`,
        error,
      );
      throw new InternalServerErrorException('Could not process knowledge gap');
    }
  }

  async getKnowledgeGapAlerts(
    threshold: number = 3,
    tenantId?: string,
  ): Promise<KnowledgeGap[]> {
    try {
      return await this.prisma.knowledgeGap.findMany({
        where: {
          resolved: false,
          occurrences: { gte: threshold },
          ...(tenantId ? { tenantId } : {}),
        },
        orderBy: { occurrences: 'desc' },
      });
    } catch (error) {
      this.logger.error('Failed to fetch knowledge gap alerts', error);
      throw new InternalServerErrorException('Could not fetch knowledge gaps');
    }
  }

  async resolveGap(id: string): Promise<KnowledgeGap> {
    try {
      return await this.prisma.knowledgeGap.update({
        where: { id },
        data: { resolved: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException(`Knowledge gap with ID ${id} not found`);
      }
      this.logger.error(`Failed to resolve knowledge gap ${id}`, error);
      throw new InternalServerErrorException('Could not resolve knowledge gap');
    }
  }

  async getActivityFeed(
    tenantId: string,
    query: ActivityFeedQueryDto,
  ): Promise<{
    data: Array<{
      id: string;
      time: Date;
      client: string;
      company: string;
      classification: string | null;
      confidence: number | null;
      action: string | null;
    }>;
    meta: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  }> {
    let targetDate: Date;
    if (query.date) {
      targetDate = new Date(query.date);
      if (isNaN(targetDate.getTime())) {
        throw new BadRequestException('Invalid date format');
      }
    } else {
      targetDate = new Date();
    }

    const year = targetDate.getUTCFullYear();
    const month = targetDate.getUTCMonth();
    const day = targetDate.getUTCDate();

    const start = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));

    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Prisma.InteractionWhereInput = {
      date: {
        gte: start,
        lte: end,
      },
      client: {
        tenantId,
      },
    };

    try {
      const [total, interactions] = await Promise.all([
        this.prisma.interaction.count({ where }),
        this.prisma.interaction.findMany({
          where,
          include: {
            client: true,
          },
          orderBy: {
            date: 'desc',
          },
          skip,
          take: limit,
        }),
      ]);

      const data = interactions.map((interaction) => ({
        id: interaction.id,
        time: interaction.date,
        client: interaction.client.name || '',
        company: interaction.client.company || '',
        classification: interaction.classification,
        confidence: interaction.productConfidence,
        action: interaction.recommendation,
      }));

      const totalPages = Math.ceil(total / limit);

      return {
        data,
        meta: {
          total,
          page,
          limit,
          totalPages,
        },
      };
    } catch (error) {
      this.logger.error('Failed to retrieve activity feed', error);
      throw new InternalServerErrorException(
        'Could not retrieve activity feed',
      );
    }
  }
}
