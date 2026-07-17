import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { TenantsService } from './tenants.service';
import { SignupTenantDto, VerifyTenantDto } from './tenants.dto';
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

  @Get('verify')
  @ApiOperation({ summary: 'Verify a tenant email using the emailed token' })
  @ApiResponse({ status: 200, description: 'Tenant verified.' })
  async verify(@Query() dto: VerifyTenantDto) {
    return this.tenantsService.verify(dto.token, dto.email);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a tenant by id' })
  @ApiParam({ name: 'id', description: 'Tenant id' })
  @ApiResponse({ status: 200, description: 'The tenant.' })
  async getTenant(@Param('id') id: string) {
    return this.tenantsService.getTenant(id);
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
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateTenantDto,
  ) {
    return this.tenantsService.updateTenant(tenantId, dto);
  }
}
