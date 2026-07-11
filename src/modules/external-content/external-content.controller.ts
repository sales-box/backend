import { Body, Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ExternalContentService } from './external-content.service';
import { ResolveExternalContentDto } from './dto/resolve-external-content.dto';
import { ResolvedExternalContentDto } from './dto/resolved-external-content.dto';
import { ResolvedExternalContent } from './external-content.types';

/**
 * Manual trigger for the external content resolver (US-043). This is a
 * demo/admin entry point — NOT the automatic email-pipeline hook (that wiring
 * belongs to the email module owner). Rate-limited by the global throttler.
 */
@ApiTags('external-content')
@Controller('external-content')
export class ExternalContentController {
  constructor(private readonly service: ExternalContentService) {}

  @Post('resolve')
  @ApiOkResponse({ type: [ResolvedExternalContentDto] })
  resolve(
    @Body() dto: ResolveExternalContentDto,
  ): Promise<ResolvedExternalContent[]> {
    // TODO(admin-auth): take tenantId from the JWT claim, not the body.
    return this.service.resolveExternalContent(
      dto.emailBody,
      dto.interactionId,
      dto.tenantId,
    );
  }
}
