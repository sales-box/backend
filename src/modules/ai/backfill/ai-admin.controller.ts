import {
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '@/modules/auth/jwt-auth.guard';
import { PrismaService } from '@/database/prisma.service';
import { InboxBackfillListener } from '@/modules/ai/classifier/inbox-backfill.listener';
import { BackfillThreadIdService } from './backfill-thread-id.service';
import type { BackfillResult } from './backfill-thread-id.service';

/**
 * One-off maintenance endpoints.
 * Protected by the shared JWT guard + an in-handler isAdmin check so these
 * are never callable by regular SE users.
 */
@ApiTags('ai-admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai/admin')
export class AiAdminController {
  constructor(
    private readonly backfillService: BackfillThreadIdService,
    private readonly inboxBackfill: InboxBackfillListener,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * POST /ai/admin/backfill-inbox
   *
   * Runs the existing-mail pass over every connected Sales Engineer mailbox in
   * the caller's tenant, without waiting for a connect event.
   *
   * WHY THIS IS NOT OPTIONAL. The automatic trigger is
   * `gmail.watch.established`, which fires when a mailbox is CONNECTED. Every
   * company that connected before this feature existed therefore never gets a
   * backfill at all — the exact customers whose inbox the feature was written
   * to rescue. Their only recourse would be disconnecting and reconnecting a
   * working mailbox, which is not something to ask a paying customer to do.
   *
   * It is also the recovery path. A backfill that exhausts its retries stays in
   * the queue as a finished job, and re-running it any other way depends on an
   * event nobody can fire on demand.
   *
   * Returns immediately: the work is queued, not awaited. One pass can be
   * hundreds of Gmail fetches and LLM calls and must not be held open by an
   * HTTP request. Watch the `classifier-backfill` queue, or the logs, for
   * "Backfill for <address> complete".
   */
  @Post('backfill-inbox')
  @HttpCode(202)
  @ApiOperation({
    summary:
      "Queue the existing-mail pass for this tenant's mailboxes (admin only)",
  })
  async backfillInbox(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ queued: string[] }> {
    if (!req.user.isAdmin) {
      throw new ForbiddenException('Admin access required');
    }

    // Tenant-scoped, never global: an operator triggering maintenance must not
    // be able to spend another company's LLM budget from their own session.
    // Admin mailboxes are excluded for the same reason the listener excludes
    // them — an admin's inbox is not a Sales Engineer's to analyse.
    const accounts = await this.prisma.connectedAccount.findMany({
      where: {
        tenantId: req.user.tenantId,
        status: 'connected',
        isAdmin: false,
      },
      select: { email: true },
    });

    for (const account of accounts) {
      await this.inboxBackfill.enqueue(account.email);
    }

    return { queued: accounts.map((a) => a.email) };
  }

  /**
   * POST /ai/admin/backfill-thread-ids
   *
   * One-time fix: for every GeneralAnalysis row where threadId IS NULL,
   * re-fetches the message from Gmail and writes the recovered threadId back.
   *
   * Idempotent — safe to re-run. Stops early and sets rateLimited=true if
   * Gmail returns a 429 mid-run; simply POST again after the quota window
   * resets to resume from where it left off (only untouched rows are visited).
   *
   * Response shape:
   *   { updated, skippedGone, failed, rateLimited }
   *   updated     – rows now have a non-null threadId
   *   skippedGone – messages permanently deleted from Gmail (404/410); threadId
   *                 is unrecoverable for these rows
   *   failed      – unexpected errors (auth, network); check server logs
   *   rateLimited – true if the run was cut short by a 429
   */
  @Post('backfill-thread-ids')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Backfill threadId on pre-fix GeneralAnalysis rows (admin only, idempotent)',
  })
  async backfillThreadIds(
    @Req() req: AuthenticatedRequest,
  ): Promise<BackfillResult> {
    if (!req.user.isAdmin) {
      throw new ForbiddenException('Admin access required');
    }
    return this.backfillService.run();
  }
}
