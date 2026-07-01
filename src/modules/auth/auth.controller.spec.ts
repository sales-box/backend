import { HttpStatus } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x';
  const authService = {
    buildGoogleAuthUrl: jest.fn().mockReturnValue(authUrl),
  } as unknown as AuthService;
  const controller = new AuthController(authService);

  it('GET /auth/google 302-redirects to the built Google auth URL', () => {
    expect(controller.googleAuth()).toEqual({
      url: authUrl,
      statusCode: HttpStatus.FOUND, // 302
    });
  });
});
