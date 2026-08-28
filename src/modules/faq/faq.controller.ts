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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';
import { FaqService } from './faq.service';

@ApiTags('faq')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminTenantGuard)
@Controller('knowledge-base/faq')
export class FaqController {
  constructor(private readonly faqService: FaqService) {}

  private requireTenant(req: AuthenticatedRequest): string {
    const { tenantId } = req.user;
    if (!tenantId)
      throw new BadRequestException('Your session carries no company');
    return tenantId;
  }

  @Post('upload')
  @ApiOperation({ summary: 'Upload a FAQ file (.md, .csv, or .xlsx)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiOkResponse({ description: 'FAQ items parsed and stored' })
  async upload(@Req() req: AuthenticatedRequest) {
    const tenantId = this.requireTenant(req);
    if (!req.isMultipart()) {
      throw new BadRequestException('Request must be multipart/form-data');
    }
    const file = await req.file();
    if (!file) throw new BadRequestException('A file field is required');

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      throw new BadRequestException('File exceeds the 25MB size limit');
    }

    return this.faqService.ingest(
      tenantId,
      file.filename,
      buffer,
      req.user.email,
    );
  }

  @Get('documents')
  @ApiOperation({ summary: 'List all FAQ documents for this tenant' })
  @ApiOkResponse({ description: 'FAQ document list' })
  listDocuments(@Req() req: AuthenticatedRequest) {
    return this.faqService.listDocuments(this.requireTenant(req));
  }

  @Get('items')
  @ApiOperation({ summary: 'List FAQ items with pagination' })
  @ApiOkResponse({ description: 'Paginated FAQ items' })
  listItems(
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.faqService.listItems(
      this.requireTenant(req),
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Delete('documents')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete ALL FAQ documents and items for this tenant',
  })
  @ApiOkResponse({ description: 'Number of documents deleted' })
  deleteAll(@Req() req: AuthenticatedRequest) {
    return this.faqService.deleteAll(this.requireTenant(req));
  }

  @Delete('documents/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a FAQ document and all its items' })
  @ApiParam({ name: 'id', description: 'FAQ document id (uuid)' })
  @ApiNoContentResponse({ description: 'FAQ document deleted' })
  async deleteDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.faqService.deleteDocument(this.requireTenant(req), id);
  }

  @Delete('items/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a single FAQ item' })
  @ApiParam({ name: 'id', description: 'FAQ item id (uuid)' })
  @ApiNoContentResponse({ description: 'FAQ item deleted' })
  async deleteItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.faqService.deleteItem(this.requireTenant(req), id);
  }
}
