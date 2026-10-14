import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { QUALITY_QUEUE, EVALUATE_QUALITY_JOB } from './quality.constants';

/**
 * Self-healing safety net for the Layer-1 quality gate.
 *
 * A document normally gets its quality score from a job the embeddings
 * processor chains right after indexing. That chain can be skipped in ways
 * that leave a document permanently stuck on "Evaluating quality…":
 *   - the database is swapped underneath a shared Redis (the enqueued jobs
 *     targeted the old DB's document ids), or
 *   - the enqueue was lost (worker down / Redis blip at upload time).
 *
 * This service reconciles that gap without any manual action: it re-enqueues
 * evaluation for every completed, chunked document that still has no score —
 * once at startup and then periodically. A deterministic jobId collapses
 * repeats so a stuck document is never enqueued twice while a job is pending.
 */
@Injectable()
export class QualityReconcilerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(QualityReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUALITY_QUEUE) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.safeReconcile('startup');
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async handleCron(): Promise<void> {
    await this.safeReconcile('scheduled');
  }

  /**
   * Re-enqueue quality evaluation for every completed document that has
   * chunks but no score yet. Idempotent. Returns the number of jobs enqueued.
   */
  async reconcile(): Promise<number> {
    const stuck = await this.prisma.document.findMany({
      where: { status: 'completed', qualityScore: null, chunkCount: { gt: 0 } },
      select: { id: true },
    });
    if (stuck.length === 0) return 0;

    for (const { id } of stuck) {
      await this.queue.add(
        EVALUATE_QUALITY_JOB,
        { documentId: id },
        {
          jobId: `reconcile-quality-${id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
        },
      );
    }
    this.logger.log(
      `reconciled ${stuck.length} document(s) missing a quality score`,
    );
    return stuck.length;
  }

  private async safeReconcile(trigger: string): Promise<void> {
    try {
      await this.reconcile();
    } catch (err) {
      this.logger.error(
        `${trigger} quality reconcile failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
