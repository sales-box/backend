import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { KnowledgeBaseService } from './knowledge-base.service';
import { UploadResponseDto } from './dto/upload-response.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { Throttle } from '@nestjs/throttler';

@ApiTags('knowledge-base')
@Controller('knowledge-base')
export class KnowledgeBaseController {
  constructor(private readonly knowledgeBaseService: KnowledgeBaseService) {}

  @Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 uploads per minute per IP
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
  async upload(@Req() req: FastifyRequest): Promise<UploadResponseDto> {
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

    return this.knowledgeBaseService.ingest({
      filename: file.filename,
      mimetype: file.mimetype,
      buffer,
    });
  }

  // TODO(Admin Auth): guard with tenant scope once C2/C3 land.
  @Get('documents')
  @ApiOkResponse({
    description: 'Paginated list of knowledge-base documents (newest first)',
  })
  listDocuments(@Query() query: PaginationQueryDto) {
    return this.knowledgeBaseService.listDocuments({
      page: query.page,
      limit: query.limit,
    });
  }

  // TODO(Admin Auth): guard with tenant scope once C2/C3 land.
  @Delete('documents/:id')
  @HttpCode(204)
  @ApiParam({ name: 'id', description: 'Document id (uuid)' })
  @ApiNoContentResponse({ description: 'Document deleted' })
  async deleteDocument(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.knowledgeBaseService.deleteDocument(id);
  }
}
