import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ExternalContentService } from './external-content.service';
import { ResolveExternalContentDto } from './dto/resolve-external-content.dto';
import { ResolvedExternalContentDto } from './dto/resolved-external-content.dto';
import { ResolvedExternalContent } from './external-content.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';

/**
 * Manual trigger for the external content resolver (US-043). This is a
 * demo/admin entry point — NOT the automatic email-pipeline hook (that wiring
 * belongs to the email module owner). Rate-limited by the global throttler.
 */
@ApiTags('external-content')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard) // tenant identity comes from the JWT claim
@Controller('external-content')
export class ExternalContentController {
  constructor(private readonly service: ExternalContentService) {}

  @Post('resolve')
  @ApiOkResponse({ type: [ResolvedExternalContentDto] })
  resolve(
    @Body() dto: ResolveExternalContentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ResolvedExternalContent[]> {
    return this.service.resolveExternalContent(
      dto.emailBody,
      dto.interactionId,
      req.user.tenantId ?? undefined,
    );
  }
}
