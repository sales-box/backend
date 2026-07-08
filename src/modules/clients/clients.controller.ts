import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
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
  async createClient(@Body() body: CreateClientDto) {
    return this.clientsService.getOrCreateClient(
      body.email,
      body.name,
      body.company,
    );
  }

  @Post(':id/interactions')
  @ApiOkResponse({ description: 'Add interaction history to client' })
  async addInteraction(
    @Param('id') id: string,
    @Body() body: CreateInteractionDto,
  ) {
    return this.clientsService.addInteraction(id, body);
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Get client with latest 20 interactions' })
  async getClient(@Param('id') id: string) {
    return this.clientsService.getClient(id);
  }

  @Get()
  @ApiOkResponse({ description: 'Get paginated list of clients' })
  async getClients(@Query() query: GetClientsQueryDto) {
    return this.clientsService.getClients(query.search, {
      page: query.page,
      limit: query.limit,
    });
  }

  @Get(':clientId/interactions')
  @ApiOkResponse({ description: 'Get interaction history for a client' })
  async getInteractions(
    @Param('clientId') clientId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.clientsService.getInteractions(clientId, {
      page: query.page,
      limit: query.limit,
    });
  }
}
