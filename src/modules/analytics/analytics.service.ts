import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma, KnowledgeGap } from '@prisma/client';
import { AnalyticsSummary } from './types/analytics.types';
import { ActivityFeedQueryDto } from './dto/activity-feed-query.dto';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getAnalyticsSummary(
    days: number = 7,
    tenantId?: string,
  ): Promise<AnalyticsSummary> {
    if (!Number.isFinite(days) || days <= 0) {
      throw new BadRequestException('days must be a positive number');
    }

    try {
      const since = new Date();
      since.setDate(since.getDate() - days);

      // Baseline tenant isolation: interactions are scoped through their
      // client. Two companies with the same email volume keep separate
      // numbers. The full caller-is-admin-of-this-tenant guard is the
      // Analytics Guard's job — this filter only stops cross-tenant mixing.
      // TODO(admin-auth): derive tenantId from the JWT claim.
      const where = {
        date: { gte: since },
        ...(tenantId ? { client: { tenantId } } : {}),
      };

      const [total, byClassificationRaw, confidenceStats, lowConfidenceCount] =
        await Promise.all([
          this.prisma.interaction.count({ where }),
          this.prisma.interaction.groupBy({
            by: ['classification'],
            where,
            _count: { classification: true },
          }),
          this.prisma.interaction.aggregate({
            where,
            _avg: { productConfidence: true, clientHistoryConfidence: true },
          }),
          this.prisma.interaction.count({
            where: {
              ...where,
              OR: [
                { productConfidence: { lt: 0.6 } },
                { clientHistoryConfidence: { lt: 0.6 } },
              ],
            },
          }),
        ]);

      const byClassification: Record<string, number> = {};
      for (const row of byClassificationRaw) {
        if (row.classification) {
          byClassification[row.classification] = row._count.classification;
        }
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

      return {
        totalEmailsProcessed: total,
        byClassification,
        averageConfidence,
        lowConfidenceCount,
      };
    } catch (error) {
      this.logger.error('Failed to compute analytics summary', error);
      throw new InternalServerErrorException(
        'Could not compute analytics summary',
      );
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
