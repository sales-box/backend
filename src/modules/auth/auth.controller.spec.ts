import { BadRequestException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
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

function makeReply(): FastifyReply & {
  setCookie: jest.Mock;
  clearCookie: jest.Mock;
} {
  return {
    setCookie: jest.fn(),
    clearCookie: jest.fn(),
  } as unknown as FastifyReply & {
    setCookie: jest.Mock;
    clearCookie: jest.Mock;
  };
}

/** Request whose signed state cookie unsigns to the given value. */
function makeRequest(stateCookie?: string): FastifyRequest {
  return {
    cookies: stateCookie ? { oauth_state: `signed:${stateCookie}` } : {},
    unsignCookie: (raw: string) => ({
      valid: raw.startsWith('signed:'),
      value: raw.replace(/^signed:/, ''),
    }),
  } as unknown as FastifyRequest;
}

describe('AuthController googleAuth', () => {
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x';
  let buildGoogleAuthUrl: jest.Mock;
  let controller: AuthController;

  beforeEach(() => {
    buildGoogleAuthUrl = jest.fn().mockReturnValue(authUrl);
    const authService = { buildGoogleAuthUrl } as unknown as AuthService;
    controller = new AuthController(authService, makeConfig());
  });

  it('GET /auth/google 302-redirects to the built Google auth URL', () => {
    const reply = makeReply();
    expect(controller.googleAuth(reply)).toEqual({
      url: authUrl,
      statusCode: HttpStatus.FOUND, // 302
    });
  });

  it('sets a signed HttpOnly state cookie and passes the same state to the auth URL', () => {
    const reply = makeReply();
    controller.googleAuth(reply);

    expect(reply.setCookie).toHaveBeenCalledTimes(1);
    const [name, value, options] = reply.setCookie.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe('oauth_state');
    expect(value).toMatch(/^[0-9a-f]{32}$/); // 16 random bytes, hex
    expect(options).toMatchObject({
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      path: '/auth',
    });
    expect(buildGoogleAuthUrl).toHaveBeenCalledWith(value);
  });
});

describe('AuthController googleCallback', () => {
  const STATE = 'a'.repeat(32);
  let handleGoogleCallback: jest.Mock;
  let controller: AuthController;

  beforeEach(() => {
    handleGoogleCallback = jest.fn();
    const authService = { handleGoogleCallback } as unknown as AuthService;
    controller = new AuthController(authService, makeConfig());
  });

  it('redirects to the dashboard with ?status=connected on success', async () => {
    handleGoogleCallback.mockResolvedValue({ email: 'seller@example.com' });

    const res = await controller.googleCallback(
      { code: 'good-code', state: STATE },
      makeRequest(STATE),
      makeReply(),
    );

    expect(res.statusCode).toBe(HttpStatus.FOUND);
    const url = new URL(res.url);
    expect(`${url.origin}${url.pathname}`).toBe(DASHBOARD);
    expect(url.searchParams.get('status')).toBe('connected');
    expect(handleGoogleCallback).toHaveBeenCalledWith('good-code');
  });

  it('redirects to ?status=error&retry=1 when the service throws (no 500)', async () => {
    handleGoogleCallback.mockRejectedValue(new BadRequestException('bad code'));

    const res = await controller.googleCallback(
      { code: 'bad-code', state: STATE },
      makeRequest(STATE),
      makeReply(),
    );

    expect(res.statusCode).toBe(HttpStatus.FOUND);
    const url = new URL(res.url);
    expect(`${url.origin}${url.pathname}`).toBe(DASHBOARD);
    expect(url.searchParams.get('status')).toBe('error');
    expect(url.searchParams.get('retry')).toBe('1');
  });

  it('redirects to error without calling the service when Google returns ?error', async () => {
    const res = await controller.googleCallback(
      { error: 'access_denied' },
      makeRequest(STATE),
      makeReply(),
    );

    expect(res.statusCode).toBe(HttpStatus.FOUND);
    expect(new URL(res.url).searchParams.get('status')).toBe('error');
    expect(handleGoogleCallback).not.toHaveBeenCalled();
  });

  it('rejects a callback whose ?state does not match the cookie (login CSRF)', async () => {
    const res = await controller.googleCallback(
      { code: 'good-code', state: 'b'.repeat(32) },
      makeRequest(STATE),
      makeReply(),
    );

    expect(new URL(res.url).searchParams.get('status')).toBe('error');
    expect(handleGoogleCallback).not.toHaveBeenCalled();
  });

  it('rejects a callback with no state cookie at all', async () => {
    const res = await controller.googleCallback(
      { code: 'good-code', state: STATE },
      makeRequest(undefined),
      makeReply(),
    );

    expect(new URL(res.url).searchParams.get('status')).toBe('error');
    expect(handleGoogleCallback).not.toHaveBeenCalled();
  });

  it('always clears the one-shot state cookie', async () => {
    const reply = makeReply();
    handleGoogleCallback.mockResolvedValue({ email: 'seller@example.com' });

    await controller.googleCallback(
      { code: 'good-code', state: STATE },
      makeRequest(STATE),
      reply,
    );

    expect(reply.clearCookie).toHaveBeenCalledWith('oauth_state', {
      path: '/auth',
    });
  });
});
