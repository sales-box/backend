import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CrmService } from './crm.service';
import { ConnectCrmDto } from './dto/connect-crm.dto';
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
}
