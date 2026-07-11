import { ValidationPipe } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import * as googleapis from 'googleapis';
import request from 'supertest';
import { AuthController } from './../src/modules/auth/auth.controller';
import { AuthService } from './../src/modules/auth/auth.service';
import { CryptoService } from './../src/modules/auth/crypto.service';
import { PrismaService } from './../src/database/prisma.service';

jest.mock('googleapis', () => {
  const getToken = jest.fn();
  const setCredentials = jest.fn();
  const getProfile = jest.fn();
  return {
    __mocks: { getToken, setCredentials, getProfile },
    google: {
      auth: {
        OAuth2: jest
          .fn()
          .mockImplementation(() => ({ getToken, setCredentials })),
      },
      gmail: jest.fn().mockReturnValue({ users: { getProfile } }),
    },
  };
});

const gmocks = (googleapis as unknown as { __mocks: Record<string, jest.Mock> })
  .__mocks;

describe('Auth (e2e)', () => {
  const DASHBOARD = 'http://localhost:5173/dashboard';
  const env: Record<string, string> = {
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
    GOOGLE_SCOPES: 'https://www.googleapis.com/auth/gmail.readonly',
    FRONTEND_DASHBOARD_URL: DASHBOARD,
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 'k').toString('base64'),
  };

  let app: NestFastifyApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthService,
        CryptoService,
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn() },
        },
        {
          provide: PrismaService,
          useValue: {
            connectedAccount: {
              findFirst: jest.fn().mockResolvedValue(null),
              create: jest.fn().mockResolvedValue({
                id: 'mock-id',
                email: 'mock@example.com',
              }),
              update: jest.fn().mockResolvedValue({
                id: 'mock-id',
                email: 'mock@example.com',
              }),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string): string => {
              const value = env[key];
              if (value === undefined)
                throw new Error(`Missing config: ${key}`);
              return value;
            },
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    // Mirror main.ts cookie support (signed OAuth state cookie).
    await app.register(fastifyCookie, {
      secret: 'test-cookie-secret-0123456789ab',
    });
    // Mirror main.ts global validation so the 400 path is exercised.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  /** Runs the login step and returns the state cookie + state value. */
  async function startOAuthFlow(): Promise<{ cookie: string; state: string }> {
    const res = await request(app.getHttpServer())
      .get('/auth/google')
      .expect(302);
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const cookie = setCookie[0].split(';')[0]; // "oauth_state=<signed value>"
    const state = new URL(res.headers.location).searchParams.get('state');
    if (!state) throw new Error('auth URL is missing the state param');
    return { cookie, state };
  }

  afterEach(async () => {
    await app.close();
  });

  it('/auth/google (GET) 302-redirects to the Google consent screen', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/google')
      .expect(302);

    const location = new URL(res.headers.location);
    expect(`${location.origin}${location.pathname}`).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(location.searchParams.get('client_id')).toBe(env.GOOGLE_CLIENT_ID);
    // CSRF: state present in the URL and mirrored in the state cookie.
    expect(location.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers['set-cookie'][0]).toContain('oauth_state=');
  });

  it('/auth/google/callback?code=good -> 302 dashboard ?status=connected', async () => {
    gmocks.getToken.mockResolvedValue({
      tokens: {
        access_token: 'access',
        refresh_token: 'refresh',
        expiry_date: 1893456000000,
        scope: env.GOOGLE_SCOPES,
      },
    });
    gmocks.getProfile.mockResolvedValue({
      data: { emailAddress: 'seller@example.com' },
    });

    const { cookie, state } = await startOAuthFlow();
    const res = await request(app.getHttpServer())
      .get(`/auth/google/callback?code=good-code&state=${state}`)
      .set('Cookie', cookie)
      .expect(302);

    const location = new URL(res.headers.location);
    expect(`${location.origin}${location.pathname}`).toBe(DASHBOARD);
    expect(location.searchParams.get('status')).toBe('connected');
  });

  it('/auth/google/callback?code=bad -> 302 dashboard ?status=error&retry=1', async () => {
    gmocks.getToken.mockRejectedValue(new Error('invalid_grant'));

    const { cookie, state } = await startOAuthFlow();
    const res = await request(app.getHttpServer())
      .get(`/auth/google/callback?code=bad-code&state=${state}`)
      .set('Cookie', cookie)
      .expect(302);

    const location = new URL(res.headers.location);
    expect(`${location.origin}${location.pathname}`).toBe(DASHBOARD);
    expect(location.searchParams.get('status')).toBe('error');
    expect(location.searchParams.get('retry')).toBe('1');
  });

  it('callback with a forged state -> 302 error, code never exchanged', async () => {
    const { cookie } = await startOAuthFlow();
    const res = await request(app.getHttpServer())
      .get(`/auth/google/callback?code=good-code&state=${'b'.repeat(32)}`)
      .set('Cookie', cookie)
      .expect(302);

    expect(new URL(res.headers.location).searchParams.get('status')).toBe(
      'error',
    );
    expect(gmocks.getToken).not.toHaveBeenCalled();
  });

  it('callback without the state cookie -> 302 error, code never exchanged', async () => {
    const { state } = await startOAuthFlow();
    const res = await request(app.getHttpServer())
      .get(`/auth/google/callback?code=good-code&state=${state}`)
      .expect(302);

    expect(new URL(res.headers.location).searchParams.get('status')).toBe(
      'error',
    );
    expect(gmocks.getToken).not.toHaveBeenCalled();
  });

  it('/auth/google/callback?error=access_denied -> 302 error redirect', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/google/callback?error=access_denied')
      .expect(302);

    expect(new URL(res.headers.location).searchParams.get('status')).toBe(
      'error',
    );
    expect(gmocks.getToken).not.toHaveBeenCalled();
  });

  it('accepts the real Google callback params (code, scope, iss, authuser, prompt) -> 302 connected', async () => {
    gmocks.getToken.mockResolvedValue({
      tokens: {
        access_token: 'access',
        refresh_token: 'refresh',
        expiry_date: 1893456000000,
        scope: env.GOOGLE_SCOPES,
      },
    });
    gmocks.getProfile.mockResolvedValue({
      data: { emailAddress: 'seller@example.com' },
    });

    const { cookie, state } = await startOAuthFlow();
    const query =
      'code=good' +
      `&state=${state}` +
      '&scope=' +
      encodeURIComponent(env.GOOGLE_SCOPES) +
      '&iss=' +
      encodeURIComponent('https://accounts.google.com') +
      '&authuser=0&prompt=consent';

    const res = await request(app.getHttpServer())
      .get(`/auth/google/callback?${query}`)
      .set('Cookie', cookie)
      .expect(302);

    expect(new URL(res.headers.location).searchParams.get('status')).toBe(
      'connected',
    );
  });

  it('/auth/google/callback with an unknown query param -> 400 (global ValidationPipe)', async () => {
    await request(app.getHttpServer())
      .get('/auth/google/callback?code=good&injected=1')
      .expect(400);
  });
});
