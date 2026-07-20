import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/database/prisma.service';
import { GmailProvider } from '@/modules/email/gmail/gmail-provider.service';

/** Mirror the same helpers used by ClassifierProcessor for consistent error handling. */
function httpStatusOf(error: unknown): number | undefined {
  return (
    (error as { code?: number }).code ??
    (error as { response?: { status?: number } }).response?.status
  );
}

function isMessageGoneError(error: unknown): boolean {
  const status = httpStatusOf(error);
  return status === 404 || status === 410;
}

function isRateLimitError(error: unknown): boolean {
  if (httpStatusOf(error) === 429) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b/.test(message);
}

export interface BackfillResult {
  updated: number;
  skippedGone: number;
  failed: number;
  rateLimited: boolean;
}

/**
 * One-time maintenance service: backfills threadId on GeneralAnalysis rows
 * that were stored before the fix-threadid-fastpath change landed and still
 * have threadId = null.
 *
 * Design choices:
 *  - Paginated in batches of `batchSize` to avoid loading the whole table at once.
 *  - Idempotent: only ever touches rows still at threadId = null, so a partial
 *    run followed by a retry resumes exactly where it left off.
 *  - Stops on 429 (rate limit) so the caller can surface this to the operator
 *    rather than burning through remaining Gmail quota.
 *  - Skips permanently deleted messages (404/410) — their threadId is
 *    unrecoverable, matching the isMessageGoneError pattern in classifier.processor.ts.
 */
@Injectable()
export class BackfillThreadIdService {
  private readonly logger = new Logger(BackfillThreadIdService.name);
  private readonly BATCH_SIZE = 20;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gmailProvider: GmailProvider,
  ) {}

  async run(): Promise<BackfillResult> {
    let updated = 0;
    let skippedGone = 0;
    let failed = 0;
    let cursor: string | undefined = undefined;

    this.logger.log('Starting threadId backfill for GeneralAnalysis rows…');

    while (true) {
      const batch = (await this.prisma.generalAnalysis.findMany({
        where: { threadId: null },
        orderBy: { id: 'asc' },
        take: this.BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, messageId: true, accountEmail: true },
      })) as Array<{ id: string; messageId: string; accountEmail: string }>;

      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;

      for (const row of batch) {
        try {
          const parsed = await this.gmailProvider.fetchMessage(
            row.messageId,
            row.accountEmail,
          );

          const threadId = parsed.threadId || null;
          await this.prisma.generalAnalysis.update({
            where: { id: row.id },
            data: { threadId },
          });
          updated += 1;
          this.logger.debug(
            `Backfilled threadId=${threadId} for messageId=${row.messageId}`,
          );
        } catch (error) {
          if (isMessageGoneError(error)) {
            this.logger.warn(
              `Message ${row.messageId} is gone (404/410) — skipping permanently`,
            );
            skippedGone += 1;
            continue;
          }

          if (isRateLimitError(error)) {
            // Stop immediately — every further Gmail call this minute would 429 too.
            this.logger.warn(
              `Gmail rate-limited (429) after ${updated} updates — stopping early. Re-run to continue.`,
            );
            this.logger.log(
              `Backfill interrupted. updated=${updated} skippedGone=${skippedGone} failed=${failed} rateLimited=true`,
            );
            return { updated, skippedGone, failed, rateLimited: true };
          }

          failed += 1;
          this.logger.error(
            `Failed to backfill messageId=${row.messageId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    this.logger.log(
      `Backfill complete. updated=${updated} skippedGone=${skippedGone} failed=${failed} rateLimited=false`,
    );
    return { updated, skippedGone, failed, rateLimited: false };
  }
}
