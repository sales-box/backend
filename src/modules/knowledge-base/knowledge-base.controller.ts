import { BadRequestException, Controller, Post, Req } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { KnowledgeBaseService } from './knowledge-base.service';
import { UploadResponseDto } from './dto/upload-response.dto';
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
}
