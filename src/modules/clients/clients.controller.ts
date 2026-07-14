import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ClientsService } from './clients.service';
import {
  CreateClientDto,
  CreateInteractionDto,
  GetClientsQueryDto,
} from './clients.dto';
import { PaginationQueryDto } from '@/common/dto/pagination-query.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';

@ApiTags('clients')
@ApiBearerAuth()
// JwtAuthGuard authenticates and populates req.user; AdminTenantGuard confirms
// the caller is an admin of a tenant. tenantId is taken from the verified JWT
// so a caller cannot spoof a different tenant by supplying a crafted header.
@UseGuards(JwtAuthGuard, AdminTenantGuard)
@Controller('clients')
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Post()
  @ApiOkResponse({ description: 'Create or return existing client' })
  async createClient(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateClientDto,
  ) {
    return this.clientsService.getOrCreateClient(
      req.user.tenantId!,
      body.email,
      body.name,
      body.company,
    );
  }

  @Post(':id/interactions')
  @ApiOkResponse({ description: 'Add interaction history to client' })
  async addInteraction(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: CreateInteractionDto,
  ) {
    return this.clientsService.addInteraction(req.user.tenantId!, id, body);
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Get client with latest 20 interactions' })
  async getClient(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.clientsService.getClient(req.user.tenantId!, id);
  }

  @Get('context')
  @ApiOkResponse({ description: 'Get client context for CRM' })
  async getClientContext(
    @Req() req: AuthenticatedRequest,
    @Query('email') email: string,
  ) {
    return this.clientsService.getClientContext(req.user.tenantId!, email);
  }

  @Get()
  @ApiOkResponse({ description: 'Get paginated list of clients' })
  async getClients(
    @Req() req: AuthenticatedRequest,
    @Query() query: GetClientsQueryDto,
  ) {
    return this.clientsService.getClients(req.user.tenantId!, query.search, {
      page: query.page,
      limit: query.limit,
    });
  }

  @Get(':clientId/interactions')
  @ApiOkResponse({ description: 'Get interaction history for a client' })
  async getInteractions(
    @Req() req: AuthenticatedRequest,
    @Param('clientId') clientId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.clientsService.getInteractions(req.user.tenantId!, clientId, {
      page: query.page,
      limit: query.limit,
    });
  }
}
