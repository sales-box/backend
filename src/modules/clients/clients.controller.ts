import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ClientsService } from './clients.service';
import { CreateClientDto, CreateInteractionDto } from './clients.dto';

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
}
