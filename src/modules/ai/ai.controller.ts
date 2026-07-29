import { Body, Controller, Logger, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '@/modules/auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '@/modules/auth/jwt-auth.guard';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { ProcessEmailDto } from './dto/process-email.dto';
import { ResumeGraphDto } from './dto/resume-graph.dto';

/**
 * AI processing endpoint — runs the full 4-agent pipeline for a single email:
 * classify → extract → match → compose → supervise → route.
 */
@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(private readonly orchestrator: AiOrchestratorService) {}

  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 req/min per IP
  @Post('process')
  @ApiOperation({
    summary:
      'Run the full AI pipeline for one email: classify, extract, match, draft, and route.',
  })
  async process(
    @Req() req: AuthenticatedRequest,
    @Body() body: ProcessEmailDto,
  ) {
    this.logger.log(
      `Incoming /ai/process request — messageId: ${body.messageId}, ` +
        `accountEmail: ${body.accountEmail}, tenantId: ${req.user.tenantId}, ` +
        `origin: ${req.headers.origin ?? 'unknown'}`,
    );

    return this.orchestrator.processEmail(
      body.messageId,
      body.accountEmail,
      req.user.tenantId!,
    );
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('resume')
  @ApiOperation({
    summary: 'Resume the reply graph with user feedback (edited draft).',
  })
  async resume(@Req() req: AuthenticatedRequest, @Body() body: ResumeGraphDto) {
    this.logger.log(
      `Incoming /ai/resume request — graphThreadId: ${body.graphThreadId}, ` +
        `tenantId: ${req.user.tenantId}`,
    );

    const result = await this.orchestrator.resumeGraph(
      body.graphThreadId,
      body.content,
    );

    return { memoryUpdated: result.memoryUpdated };
  }
}
