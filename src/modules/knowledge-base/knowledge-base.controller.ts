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
import {
  KbSearchRequestDto,
  KbSearchResponseDto,
  QualityCriteriaResponseDto,
  QualityPreviewResponseDto,
} from './dto/kb-search.dto';
import { describeRubric } from './quality/rubric.describe';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';
import { Throttle } from '@nestjs/throttler';

/**
 * Pulls the single uploaded file off a multipart request.
 *
 * Shared by upload and preview so they cannot drift: the null-file check and
 * the try/catch around toBuffer are not tidiness. @fastify/multipart throws
 * past the 25MB limit registered in main.ts, and this backend has no global
 * exception filter — without the catch, that error reaches the client as a
 * raw 413 instead of a sentence.
 */
async function readUploadedFile(req: AuthenticatedRequest): Promise<{
  filename: string;
  mimetype: string;
  buffer: Buffer;
}> {
  if (!req.isMultipart()) {
    throw new BadRequestException('Request must be multipart/form-data');
  }
  const file = await req.file();
  if (!file) {
    throw new BadRequestException('A file field is required');
  }
  try {
    return {
      filename: file.filename,
      mimetype: file.mimetype,
      buffer: await file.toBuffer(),
    };
  } catch {
    throw new BadRequestException('File exceeds the 25MB size limit');
  }
}

@ApiTags('knowledge-base')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard) // tenant identity comes from the JWT claim
@Controller('knowledge-base')
export class KnowledgeBaseController {
  constructor(
    private readonly knowledgeBaseService: KnowledgeBaseService,
    private readonly kbSearchService: KbSearchService,
  ) {}

  @Get('quality/criteria')
  @ApiOperation({
    summary: 'What the quality score measures, and what each part is worth',
    description:
      'The same rubric the scorer uses, described for a human. Static per deployment — safe to cache client-side.',
  })
  @ApiOkResponse({ type: QualityCriteriaResponseDto })
  qualityCriteria(): QualityCriteriaResponseDto {
    // Sorted most-valuable-first so the panel leads with what moves the score
    // most, rather than with whatever order the rules happen to be declared in.
    const { criteria, bands } = describeRubric();
    return { criteria: [...criteria].sort((a, b) => b.worth - a.worth), bands };
  }

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

  // Same 60/min as upload: this is the step BEFORE an upload, so anything
  // tighter would make the preview the bottleneck on a bulk import. Cheap by
  // comparison — parsing and regex, no database, no embedding call.
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Post('quality/preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Score a file without storing it',
    description:
      'Runs the same extraction, chunking and rubric an upload runs, and writes nothing — no document row, no chunks, and no replacement of an existing file with the same name. Repetition is not measured: that needs embeddings, which need storage.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiOkResponse({ type: QualityPreviewResponseDto })
  async previewQuality(
    @Req() req: AuthenticatedRequest,
  ): Promise<QualityPreviewResponseDto> {
    const { filename, buffer } = await readUploadedFile(req);
    return this.knowledgeBaseService.previewQuality(filename, buffer);
  }

  /**
   * A platform-operator token carries no tenantId. Passing `undefined` into a
   * Prisma `where` silently becomes `tenant_id IS NULL`, so an unchecked
   * handler reads and deletes the legacy null-tenant corpus instead of
   * failing. Refuse instead.
   */
  private requireTenant(req: AuthenticatedRequest): string {
    const { tenantId } = req.user;
    if (!tenantId) {
      throw new BadRequestException('Your session carries no company');
    }
    return tenantId;
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
    const { filename, mimetype, buffer } = await readUploadedFile(req);
    return this.knowledgeBaseService.ingest(
      { filename, mimetype, buffer },
      { tenantId: this.requireTenant(req), uploadedBy: req.user.email },
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
      this.requireTenant(req),
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
    await this.knowledgeBaseService.deleteDocument(id, this.requireTenant(req));
  }
}
