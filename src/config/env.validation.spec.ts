import 'reflect-metadata';
import { validateEnv } from './env.validation';

const validEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  COOKIE_SECRET: 'a-32-character-long-cookie-secret',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
  GOOGLE_SCOPES: 'https://www.googleapis.com/auth/gmail.readonly',
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
});
