import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  Param,
  Patch,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { TenantsService } from './tenants.service';
import {
  SignupTenantDto,
  VerifyTenantDto,
  ResendVerificationDto,
} from './tenants.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminTenantGuard } from '../../common/guards/admin-tenant.guard';

@ApiTags('tenants')
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Post('signup')
  @ApiOperation({
    summary: 'Register a new tenant (company) and send a verification email',
  })
  @ApiResponse({
    status: 201,
    description: 'Tenant created; verification email sent.',
  })
  async signup(@Body() dto: SignupTenantDto) {
    return this.tenantsService.signup(dto);
  }

  @Post('resend-verification')
  @ApiOperation({
    summary: 'Resend email verification link for a pending tenant',
  })
  @ApiResponse({
    status: 200,
    description: 'Verification email resent.',
  })
  async resendVerification(@Body() dto: ResendVerificationDto) {
    return this.tenantsService.resendVerification(dto);
  }

  @Get('verify')
  @ApiOperation({ summary: 'Verify a tenant email using the emailed token' })
  @ApiResponse({ status: 200, description: 'Tenant verified.' })
  async verify(@Query() dto: VerifyTenantDto) {
    return this.tenantsService.verify(dto.token, dto.email);
  }

  // The param is named tenantId, not id, on purpose: AdminTenantGuard scopes a
  // request by comparing `req.params.tenantId` to the tenant in the verified
  // JWT. Called `id`, the guard would authenticate the caller as some admin and
  // then never check WHICH tenant they asked for.
  @Get(':tenantId')
  @ApiBearerAuth()
  // This route had no guard at all, unlike the PATCH directly below it, so
  // anyone holding a tenant UUID — and they appear in dashboard URLs — could
  // read that company's name, plan tier and account status anonymously. Every
  // caller in the dashboard (Overview, Team, Plans, Analytics, Settings) is
  // already inside an authenticated route, so gating it breaks nothing.
  @UseGuards(JwtAuthGuard, AdminTenantGuard)
  @ApiOperation({ summary: 'Get a tenant by id' })
  @ApiParam({ name: 'tenantId', description: 'Tenant id' })
  @ApiResponse({ status: 200, description: 'The tenant.' })
  async getTenant(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.tenantsService.getTenant(tenantId);
  }

  @Patch(':tenantId')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, AdminTenantGuard)
  @ApiOperation({ summary: 'Update tenant details' })
  @ApiResponse({
    status: 200,
    description: 'The tenant details have been successfully updated.',
  })
  async updateTenant(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: UpdateTenantDto,
  ) {
    return this.tenantsService.updateTenant(tenantId, dto);
  }
}
