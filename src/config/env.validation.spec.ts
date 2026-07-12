import 'reflect-metadata';
import { validateEnv } from './env.validation';

const validEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  COOKIE_SECRET: 'a-32-character-long-cookie-secret',
  JWT_SECRET: 'a-32-plus-character-long-jwt-secret-value',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
  GOOGLE_SCOPES: 'https://www.googleapis.com/auth/gmail.readonly',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 'k').toString('base64'),
  FRONTEND_DASHBOARD_URL: 'http://localhost:5173/dashboard',
  GOOGLE_PUBSUB_VERIFICATION_TOKEN: 'token',
  GOOGLE_PUBSUB_TOPIC_NAME: 'topic',
  AWS_REGION: 'eu-north-1',
  S3_BUCKET: 'salesbox-iti',
  SMTP_USER: 'test@gmail.com',
  SMTP_PASS: 'testpass123',
};

describe('validateEnv', () => {
  it('accepts a fully-populated environment', () => {
    expect(() => validateEnv({ ...validEnv })).not.toThrow();
  });

  it.each([
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'GOOGLE_SCOPES',
    'TOKEN_ENCRYPTION_KEY',
    'FRONTEND_DASHBOARD_URL',
    'GOOGLE_PUBSUB_VERIFICATION_TOKEN',
    'GOOGLE_PUBSUB_TOPIC_NAME',
    'AWS_REGION',
    'S3_BUCKET',
  ])('throws at startup when %s is missing', (key) => {
    const env = { ...validEnv };
    delete (env as Record<string, unknown>)[key];
    expect(() => validateEnv(env)).toThrow(/Environment validation failed/);
  });

  it('rejects an empty GOOGLE_REDIRECT_URI', () => {
    expect(() => validateEnv({ ...validEnv, GOOGLE_REDIRECT_URI: '' })).toThrow(
      /Environment validation failed/,
    );
  });

  it('rejects a TOKEN_ENCRYPTION_KEY that does not decode to 32 bytes', () => {
    expect(() =>
      validateEnv({
        ...validEnv,
        TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 'k').toString('base64'),
      }),
    ).toThrow(/Environment validation failed/);
  });

  it('accepts a 64-char hex TOKEN_ENCRYPTION_KEY (32 bytes)', () => {
    expect(() =>
      validateEnv({
        ...validEnv,
        TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
      }),
    ).not.toThrow();
  });

  it('rejects a non-URL FRONTEND_DASHBOARD_URL', () => {
    expect(() =>
      validateEnv({ ...validEnv, FRONTEND_DASHBOARD_URL: 'not a url' }),
    ).toThrow(/Environment validation failed/);
  });
});
