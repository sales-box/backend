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
import { BulkGrantAllowlistDto } from './dto/bulk-grant-allowlist.dto';
import { BulkGrantResult, RevokeOutcome } from './allowlist.constants';
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
  @ApiResponse({
    status: 201,
    description:
      'The outcome: added, reactivated, or duplicate when the address was ' +
      'already on the team (in which case nothing is written and no invite is sent).',
  })
  grant(
    @Param('tenantId') tenantId: string,
    @Body() dto: GrantAllowlistDto,
  ): Promise<{ outcome: 'added' | 'reactivated' | 'duplicate' }> {
    return this.allowlistService.grantAccess(tenantId, dto.email);
  }

  // Declared before @Delete('allowlist/:email') for readability only; the two
  // never collide (different HTTP verbs, and 'bulk' is a POST path segment).
  @Post('allowlist/bulk')
  @ApiOperation({
    summary: 'Grant many email addresses at once (paste or CSV)',
    description:
      'Addresses already active on this tenant are ignored rather than re-granted. ' +
      'Revoked addresses are reactivated. Invalid rows and rows past the plan seat ' +
      'cap are reported per row instead of failing the whole request.',
  })
  @ApiParam({ name: 'tenantId', description: 'Tenant id' })
  @ApiResponse({
    status: 201,
    description: 'Per-row outcomes, a summary, and the resulting seat usage.',
  })
  grantBulk(
    @Param('tenantId') tenantId: string,
    @Body() dto: BulkGrantAllowlistDto,
  ): Promise<BulkGrantResult> {
    return this.allowlistService.grantAccessBulk(tenantId, dto.emails);
  }

  @Delete('allowlist/:email')
  @ApiOperation({ summary: 'Revoke an email address from this tenant' })
  @ApiParam({ name: 'tenantId', description: 'Tenant id' })
  @ApiParam({ name: 'email', description: 'Email address to revoke' })
  @ApiResponse({
    status: 200,
    description:
      'The outcome: revoked (access cut off and the engineer notified by email), ' +
      'already_revoked (nothing changed, no second notice sent), or not_found.',
  })
  revoke(
    @Param('tenantId') tenantId: string,
    @Param('email') email: string,
  ): Promise<{ outcome: RevokeOutcome }> {
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
