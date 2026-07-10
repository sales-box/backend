import { Controller, Post, Body, Get, Query, Param } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { SignupTenantDto, VerifyTenantDto } from './tenants.dto';

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
}
