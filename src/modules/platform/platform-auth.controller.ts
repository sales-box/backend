import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformLoginDto } from './dto/platform-login.dto';

@ApiTags('platform')
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly platformAuth: PlatformAuthService) {}

  /** Email + password login → platform JWT for the operator console. */
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // brute-force damper
  @Post('login')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Platform JWT: { token }' })
  login(@Body() dto: PlatformLoginDto): Promise<{ token: string }> {
    return this.platformAuth.login(dto.email, dto.password);
  }
}
