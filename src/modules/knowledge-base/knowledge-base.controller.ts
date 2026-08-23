import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { KnowledgeBaseService } from './knowledge-base.service';
import { KbSearchService } from './kb-search.service';
import { UploadResponseDto } from './dto/upload-response.dto';
import { KbSearchRequestDto, KbSearchResponseDto } from './dto/kb-search.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';
import { Throttle } from '@nestjs/throttler';

@ApiTags('knowledge-base')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard) // tenant identity comes from the JWT claim
@Controller('knowledge-base')
export class KnowledgeBaseController {
  constructor(
    private readonly knowledgeBaseService: KnowledgeBaseService,
    private readonly kbSearchService: KbSearchService,
  ) {}

  // 20/min, far below the upload route's 60: every call embeds the question,
  // which is a real network round trip to the embedding provider (up to 45s
  // with retries). Throttles are per-route and are NOT inherited.
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('test')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Ask the knowledge base a question and see what would be retrieved',
    description:
      'Runs the same hybrid retrieval a real reply is grounded in — semantic + keyword, fused — and stops before the LLM. Nothing is written and no reply is generated.',
  })
  @ApiOkResponse({ type: KbSearchResponseDto })
  async testKnowledgeBase(
    @Body() dto: KbSearchRequestDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<KbSearchResponseDto> {
    // The JWT's tenantId is nullable, and the retrieval helpers throw a raw
    // Error on a falsy tenant rather than a typed HTTP one — which would reach
    // the client as a 500. Refuse here, in the tenant's own language.
    const { tenantId } = req.user;
    if (!tenantId) {
      throw new BadRequestException('Your session carries no company');
    }
    return this.kbSearchService.search(tenantId, dto.question);
  }

  @Throttle({ default: { limit: 60, ttl: 60000 } }) // 60 uploads/min per IP — bulk-friendly for the 200-doc KB, still abuse-limited
  @Post('upload')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiOkResponse({ type: UploadResponseDto })
  async upload(@Req() req: AuthenticatedRequest): Promise<UploadResponseDto> {
    if (!req.isMultipart()) {
      throw new BadRequestException('Request must be multipart/form-data');
    }

    const file = await req.file();
    if (!file) {
      throw new BadRequestException('A file field is required');
    }

    let buffer: Buffer;
    try {
      // Throws when the 25MB limit (set in main.ts) is exceeded.
      buffer = await file.toBuffer();
    } catch {
      throw new BadRequestException('File exceeds the 25MB size limit');
    }

    return this.knowledgeBaseService.ingest(
      {
        filename: file.filename,
        mimetype: file.mimetype,
        buffer,
      },
      { tenantId: req.user.tenantId, uploadedBy: req.user.email },
    );
  }

  @Get('documents')
  @ApiOkResponse({
    description:
      'Paginated list of the tenant own knowledge-base documents (newest first)',
  })
  listDocuments(
    @Query() query: PaginationQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.knowledgeBaseService.listDocuments(
      { page: query.page, limit: query.limit },
      req.user.tenantId,
    );
  }

  // Declared BEFORE the ':id' route so the static segment is matched first.
  //
  // Admin-only, unlike the rest of this controller. Emptying the knowledge base
  // starves the Matcher for every SE in the tenant at once, and there is no
  // restore path — so it is gated on the admin badge rather than on merely
  // holding a valid token.
  @Delete('documents')
  @UseGuards(AdminTenantGuard)
  @HttpCode(200)
  @ApiOkResponse({
    description:
      'Every document in the caller tenant knowledge base, with its chunks and embeddings, deleted. Returns how many rows went.',
  })
  async deleteAllDocuments(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ deleted: number }> {
    // AdminTenantGuard already rejects a missing tenantId; re-checked here so
    // the service's required-string contract is honoured without a `!`.
    const { tenantId } = req.user;
    if (!tenantId) {
      throw new BadRequestException('Admin token carries no tenant');
    }
    return this.knowledgeBaseService.deleteAllDocuments(tenantId);
  }

  @Delete('documents/:id')
  @HttpCode(204)
  @ApiParam({ name: 'id', description: 'Document id (uuid)' })
  @ApiNoContentResponse({ description: 'Document deleted' })
  async deleteDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.knowledgeBaseService.deleteDocument(id, req.user.tenantId);
  }
}
