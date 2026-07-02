import { BadRequestException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

const DASHBOARD = 'http://localhost:5173/dashboard';

function makeConfig(): ConfigService {
  return {
    getOrThrow: (key: string): string => {
      if (key === 'FRONTEND_DASHBOARD_URL') return DASHBOARD;
      throw new Error(`Missing config: ${key}`);
    },
  } as unknown as ConfigService;
}

describe('AuthController googleAuth', () => {
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x';
  const authService = {
    buildGoogleAuthUrl: jest.fn().mockReturnValue(authUrl),
  } as unknown as AuthService;
  const controller = new AuthController(authService, makeConfig());

  it('GET /auth/google 302-redirects to the built Google auth URL', () => {
    expect(controller.googleAuth()).toEqual({
      url: authUrl,
      statusCode: HttpStatus.FOUND, // 302
    });
  });
});

describe('AuthController googleCallback', () => {
  let handleGoogleCallback: jest.Mock;
  let controller: AuthController;

  beforeEach(() => {
    handleGoogleCallback = jest.fn();
    const authService = { handleGoogleCallback } as unknown as AuthService;
    controller = new AuthController(authService, makeConfig());
  });

  it('redirects to the dashboard with ?status=connected on success', async () => {
    handleGoogleCallback.mockResolvedValue({ email: 'seller@example.com' });

    const res = await controller.googleCallback({ code: 'good-code' });

    expect(res.statusCode).toBe(HttpStatus.FOUND);
    const url = new URL(res.url);
    expect(`${url.origin}${url.pathname}`).toBe(DASHBOARD);
    expect(url.searchParams.get('status')).toBe('connected');
    expect(handleGoogleCallback).toHaveBeenCalledWith('good-code');
  });

  it('redirects to ?status=error&retry=1 when the service throws (no 500)', async () => {
    handleGoogleCallback.mockRejectedValue(new BadRequestException('bad code'));

    const res = await controller.googleCallback({ code: 'bad-code' });

    expect(res.statusCode).toBe(HttpStatus.FOUND);
    const url = new URL(res.url);
    expect(`${url.origin}${url.pathname}`).toBe(DASHBOARD);
    expect(url.searchParams.get('status')).toBe('error');
    expect(url.searchParams.get('retry')).toBe('1');
  });

  it('redirects to error without calling the service when Google returns ?error', async () => {
    const res = await controller.googleCallback({ error: 'access_denied' });

    expect(res.statusCode).toBe(HttpStatus.FOUND);
    expect(new URL(res.url).searchParams.get('status')).toBe('error');
    expect(handleGoogleCallback).not.toHaveBeenCalled();
  });
});
