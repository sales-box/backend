import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { AllowlistService } from './allowlist.service';
import { GrantAllowlistDto } from './dto/grant-allowlist.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';

@ApiTags('allowlist')
@ApiBearerAuth()
// JwtAuthGuard authenticates and populates req.user; AdminTenantGuard then
// confirms the caller is an admin of the :tenantId in the URL. Order matters —
// authentication must run before the tenant-match check reads req.user.
@UseGuards(JwtAuthGuard, AdminTenantGuard)
@Controller('tenants/:tenantId')
export class AllowlistController {
  constructor(private readonly allowlistService: AllowlistService) {}

  @Post('allowlist')
  @ApiOperation({ summary: 'Grant an email address access to this tenant' })
  @ApiParam({ name: 'tenantId', description: 'Tenant id' })
  @ApiResponse({ status: 201, description: 'Access granted.' })
  grant(
    @Param('tenantId') tenantId: string,
    @Body() dto: GrantAllowlistDto,
  ): Promise<void> {
    return this.allowlistService.grantAccess(tenantId, dto.email);
  }

  @Delete('allowlist/:email')
  @ApiOperation({ summary: 'Revoke an email address from this tenant' })
  @ApiParam({ name: 'tenantId', description: 'Tenant id' })
  @ApiParam({ name: 'email', description: 'Email address to revoke' })
  @ApiResponse({ status: 200, description: 'Access revoked.' })
  revoke(
    @Param('tenantId') tenantId: string,
    @Param('email') email: string,
  ): Promise<void> {
    return this.allowlistService.revokeAccess(tenantId, email);
  }

  @Get('allowlist')
  @ApiOperation({
    summary: 'List all allowlisted email addresses for this tenant',
  })
  @ApiParam({ name: 'tenantId', description: 'Tenant id' })
  @ApiResponse({ status: 200, description: 'The allowlist.' })
  list(@Param('tenantId') tenantId: string) {
    return this.allowlistService.listAllowlist(tenantId);
  }

  @Post('offboard')
  @ApiOperation({
    summary: 'Offboard the tenant: revoke all access and disconnect accounts',
  })
  @ApiParam({ name: 'tenantId', description: 'Tenant id' })
  @ApiResponse({ status: 201, description: 'Tenant offboarded.' })
  offboard(@Param('tenantId') tenantId: string): Promise<void> {
    return this.allowlistService.offboardTenant(tenantId);
  }
}
