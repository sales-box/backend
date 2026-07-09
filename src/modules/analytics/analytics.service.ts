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

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getAnalyticsSummary(days: number = 7): Promise<AnalyticsSummary> {
    if (!Number.isFinite(days) || days <= 0) {
      throw new BadRequestException('days must be a positive number');
    }

    try {
      const since = new Date();
      since.setDate(since.getDate() - days);

      const [total, byClassificationRaw, confidenceStats, lowConfidenceCount] =
        await Promise.all([
          this.prisma.interaction.count({
            where: { date: { gte: since } },
          }),
          this.prisma.interaction.groupBy({
            by: ['classification'],
            where: { date: { gte: since } },
            _count: { classification: true },
          }),
          this.prisma.interaction.aggregate({
            where: { date: { gte: since } },
            _avg: { confidence: true },
          }),
          this.prisma.interaction.count({
            where: { date: { gte: since }, confidence: { lt: 0.6 } },
          }),
        ]);

      const byClassification: Record<string, number> = {};
      for (const row of byClassificationRaw) {
        if (row.classification) {
          byClassification[row.classification] = row._count.classification;
        }
      }

      return {
        totalEmailsProcessed: total,
        byClassification,
        averageConfidence: confidenceStats._avg.confidence ?? 0,
        lowConfidenceCount,
      };
    } catch (error) {
      this.logger.error('Failed to compute analytics summary', error);
      throw new InternalServerErrorException(
        'Could not compute analytics summary',
      );
    }
  }

  async upsertKnowledgeGap(topic: string): Promise<KnowledgeGap> {
    const normalizedTopic = topic.trim().toLowerCase();

    if (!normalizedTopic) {
      throw new BadRequestException('Topic cannot be empty');
    }

    try {
      return await this.prisma.knowledgeGap.upsert({
        where: { topic: normalizedTopic },
        update: { occurrences: { increment: 1 }, resolved: false },
        create: { topic: normalizedTopic, occurrences: 1, resolved: false },
      });
    } catch (error) {
      this.logger.error(
        `Failed to upsert knowledge gap for topic: ${topic}`,
        error,
      );
      throw new InternalServerErrorException('Could not process knowledge gap');
    }
  }

  async getKnowledgeGapAlerts(threshold: number = 3): Promise<KnowledgeGap[]> {
    try {
      return await this.prisma.knowledgeGap.findMany({
        where: {
          resolved: false,
          occurrences: { gte: threshold },
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
}
