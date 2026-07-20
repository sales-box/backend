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
  constructor(private readonly backfillService: BackfillThreadIdService) {}

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
