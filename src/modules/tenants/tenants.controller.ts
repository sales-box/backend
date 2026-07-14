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
  async signup(@Body() dto: SignupTenantDto) {
    return this.tenantsService.signup(dto);
  }

  @Get('verify')
  async verify(@Query() dto: VerifyTenantDto) {
    return this.tenantsService.verify(dto.token, dto.email);
  }

  @Get(':id')
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
