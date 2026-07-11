import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CrmService } from './crm.service';
import { ConnectCrmDto } from './dto/connect-crm.dto';

@ApiTags('crm')
@Controller('tenants')
export class CrmController {
  constructor(private readonly crmService: CrmService) {}

  @Get(':id/crm/status')
  @ApiOkResponse({ description: 'Get CRM connection status for the tenant' })
  async getCrmStatus(@Param('id') tenantId: string) {
    return this.crmService.getCrmStatus(tenantId);
  }

  @Post(':id/crm/connect')
  @ApiOkResponse({
    description: 'Connect CRM account to the tenant and import contacts',
  })
  async connectCrm(@Param('id') tenantId: string, @Body() body: ConnectCrmDto) {
    return this.crmService.connectCrm(tenantId, body);
  }
}
