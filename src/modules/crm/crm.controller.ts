import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CrmService } from './crm.service';
import { ConnectCrmDto } from './dto/connect-crm.dto';
import { ConnectZohoMcpDto } from './dto/connect-zoho-mcp.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';

@ApiTags('crm')
@ApiBearerAuth()
// JwtAuthGuard authenticates and populates req.user; AdminTenantGuard confirms
// the caller is an admin of a tenant. tenantId is taken from the verified JWT,
// never from the URL param, so one tenant's admin cannot reach another tenant's
// CRM data by editing the :id in the URL.
@UseGuards(JwtAuthGuard, AdminTenantGuard)
@Controller('tenants')
export class CrmController {
  constructor(private readonly crmService: CrmService) {}

  @Get(':id/crm/status')
  @ApiOkResponse({ description: 'Get CRM connection status for the tenant' })
  async getCrmStatus(@Req() req: AuthenticatedRequest) {
    return this.crmService.getCrmStatus(req.user.tenantId!);
  }

  /**
   * Re-read the CRM with the credential already on file.
   *
   * Importing only at connect time left disconnect-and-reconnect as the only
   * way to pick up a CRM change — and that unlinks every client on the way
   * through.
   */
  @Post(':id/crm/sync')
  @ApiOkResponse({ description: 'Re-import contacts from the connected CRM' })
  async syncCrm(@Req() req: AuthenticatedRequest) {
    return this.crmService.syncCrm(req.user.tenantId!);
  }

  @Get(':id/crm/mcp-status')
  @ApiOkResponse({
    description: 'Get Zoho MCP connection status for the tenant',
  })
  async getMcpConnectionStatus(@Req() req: AuthenticatedRequest) {
    return this.crmService.getMcpConnectionStatus(req.user.tenantId!);
  }

  @Post(':id/crm/connect')
  @ApiOkResponse({
    description: 'Connect CRM account to the tenant and import contacts',
  })
  async connectCrm(
    @Req() req: AuthenticatedRequest,
    @Body() body: ConnectCrmDto,
  ) {
    return this.crmService.connectCrm(req.user.tenantId!, body);
  }

  @Post(':id/crm/connect-mcp')
  @ApiOkResponse({
    description: 'Connect Zoho MCP presigned server URL to the tenant',
  })
  async connectZohoMcp(
    @Req() req: AuthenticatedRequest,
    @Body() body: ConnectZohoMcpDto,
  ) {
    return this.crmService.connectZohoMcp(req.user.tenantId!, body);
  }

  @Delete(':id/crm/disconnect')
  @ApiOkResponse({
    description:
      'Disconnect the CRM: remove the stored key and delete imported contacts',
  })
  async disconnectCrm(@Req() req: AuthenticatedRequest) {
    return this.crmService.disconnectCrm(req.user.tenantId!);
  }

  @Delete(':id/crm/disconnect-mcp')
  @ApiOkResponse({
    description: 'Disconnect the Zoho MCP server connection for the tenant',
  })
  async disconnectZohoMcp(@Req() req: AuthenticatedRequest) {
    return this.crmService.disconnectZohoMcp(req.user.tenantId!);
  }
}
