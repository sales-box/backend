import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { SetAdminPasswordDto } from './dto/set-admin-password.dto';

@ApiTags('auth')
@Controller('auth/admin')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  /** Email + password login → JWT for the admin dashboard. */
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // brute-force damper
  @Post('login')
  @HttpCode(200)
  @ApiOkResponse({
    description: 'JWT for the admin dashboard: { token }',
  })
  login(@Body() dto: AdminLoginDto): Promise<{ token: string }> {
    return this.adminAuth.adminLoginWithPassword(dto.email, dto.password);
  }

  /**
   * One-time password setup for a tenant admin (identity-linking step).
   * Requires the Google account to be connected first; the password lands on
   * that same ConnectedAccount row.
   */
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('set-password')
  @ApiCreatedResponse({ description: 'Password linked to the admin account' })
  setPassword(@Body() dto: SetAdminPasswordDto): Promise<{ linked: true }> {
    return this.adminAuth.setAdminPassword(
      dto.email,
      dto.password,
      dto.tenantId,
    );
  }
}
