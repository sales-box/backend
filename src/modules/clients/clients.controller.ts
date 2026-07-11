import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ClientsService } from './clients.service';
import {
  CreateClientDto,
  CreateInteractionDto,
  GetClientsQueryDto,
} from './clients.dto';
import { PaginationQueryDto } from '@/common/dto/pagination-query.dto';

@ApiTags('clients')
@Controller('clients')
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Post()
  @ApiOkResponse({ description: 'Create or return existing client' })
  async createClient(
    @Headers('x-tenant-id') tenantId: string,
    @Body() body: CreateClientDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }
    return this.clientsService.getOrCreateClient(
      tenantId,
      body.email,
      body.name,
      body.company,
    );
  }

  @Post(':id/interactions')
  @ApiOkResponse({ description: 'Add interaction history to client' })
  async addInteraction(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') id: string,
    @Body() body: CreateInteractionDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }
    return this.clientsService.addInteraction(tenantId, id, body);
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Get client with latest 20 interactions' })
  async getClient(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') id: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }
    return this.clientsService.getClient(tenantId, id);
  }

  @Get('context')
  @ApiOkResponse({ description: 'Get client context for CRM' })
  async getClientContext(
    @Headers('x-tenant-id') tenantId: string,
    @Query('email') email: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }
    return this.clientsService.getClientContext(tenantId, email);
  }

  @Get()
  @ApiOkResponse({ description: 'Get paginated list of clients' })
  async getClients(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetClientsQueryDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }
    return this.clientsService.getClients(tenantId, query.search, {
      page: query.page,
      limit: query.limit,
    });
  }

  @Get(':clientId/interactions')
  @ApiOkResponse({ description: 'Get interaction history for a client' })
  async getInteractions(
    @Headers('x-tenant-id') tenantId: string,
    @Param('clientId') clientId: string,
    @Query() query: PaginationQueryDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }
    return this.clientsService.getInteractions(tenantId, clientId, {
      page: query.page,
      limit: query.limit,
    });
  }
}
