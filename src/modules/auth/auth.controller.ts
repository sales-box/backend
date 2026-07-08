import { Controller, Get, HttpStatus, Query, Redirect } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiFoundResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { GoogleCallbackDto } from './dto/google-callback.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Get('google')
  @Redirect()
  @ApiFoundResponse({
    description: 'Redirect to the Google OAuth consent screen',
  })
  googleAuth(): { url: string; statusCode: number } {
    return {
      url: this.authService.buildGoogleAuthUrl(),
      statusCode: HttpStatus.FOUND,
    };
  }

  @Get('google/callback')
  @Redirect()
  @ApiFoundResponse({
    description:
      'Redirect to the dashboard with ?status=connected on success, or ?status=error&retry=1 on failure',
  })
  async googleCallback(
    @Query() query: GoogleCallbackDto,
  ): Promise<{ url: string; statusCode: number }> {
    const dashboard = this.config.getOrThrow<string>('FRONTEND_DASHBOARD_URL');

    if (query.error || !query.code) {
      return this.redirect(dashboard, 'error');
    }

    try {
      await this.authService.handleGoogleCallback(query.code);
      return this.redirect(dashboard, 'connected');
    } catch {
      return this.redirect(dashboard, 'error');
    }
  }

  private redirect(
    dashboard: string,
    status: 'connected' | 'error',
  ): { url: string; statusCode: number } {
    const url = new URL(dashboard);
    url.searchParams.set('status', status);
    if (status === 'error') {
      url.searchParams.set('retry', '1');
    }
    return { url: url.toString(), statusCode: HttpStatus.FOUND };
  }
}
