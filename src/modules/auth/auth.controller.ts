import { Controller, Get, HttpStatus, Redirect } from '@nestjs/common';
import { ApiFoundResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
}
