import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { QUALITY_QUEUE, EvaluateQualityJobData } from './quality.constants';
import { evaluateCoverage } from './rules-evaluator';
import { computeRedundancy } from './dedup';
import { BUILTIN_RULES } from './rubric';
import { QualityReport } from './quality.types';

@Processor(QUALITY_QUEUE)
export class QualityProcessor extends WorkerHost {
  private readonly logger = new Logger(QualityProcessor.name);
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(
    job: Job<EvaluateQualityJobData>,
  ): Promise<{ score: number } | { skipped: true }> {
    const { documentId } = job.data;
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
    });
    if (!doc) return { skipped: true };

    const chunks = await this.prisma.documentChunk.findMany({
      where: { documentId },
      select: { content: true },
      orderBy: { chunkIndex: 'asc' },
    });
    const text = chunks.map((c) => c.content ?? '').join('\n');

    const coverage = evaluateCoverage(text, BUILTIN_RULES);
    const redundancy = await computeRedundancy(this.prisma, documentId);

    const report: QualityReport = {
      ...coverage,
      redundancyRatio: redundancy.redundancyRatio,
      concisenessScore: redundancy.concisenessScore,
      duplicateChunkPairs: redundancy.duplicateChunkPairs,
      evaluatedAt: new Date().toISOString(),
    };

    await this.prisma.document.update({
      where: { id: documentId },
      data: {
        qualityScore: coverage.score,
        qualityReport: report as unknown as Prisma.InputJsonValue,
      },
    });
    this.logger.log(`document ${documentId}: quality score ${coverage.score}`);
    return { score: coverage.score };
  }
}
