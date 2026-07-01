import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { AuthController } from './../src/modules/auth/auth.controller';
import { AuthService } from './../src/modules/auth/auth.service';

describe('Auth (e2e)', () => {
  const env: Record<string, string> = {
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
    GOOGLE_SCOPES: 'https://www.googleapis.com/auth/gmail.readonly',
  };

  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthService,
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
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
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
    expect(location.searchParams.get('redirect_uri')).toBe(
      env.GOOGLE_REDIRECT_URI,
    );
    expect(location.searchParams.get('scope')).toBe(env.GOOGLE_SCOPES);
  });

  afterEach(async () => {
    await app.close();
  });
});
