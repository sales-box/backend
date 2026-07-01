import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';

function makeConfig(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string): string => {
      const value = values[key];
      if (value === undefined) throw new Error(`Missing config: ${key}`);
      return value;
    },
  } as unknown as ConfigService;
}

describe('AuthService', () => {
  const env = {
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
    GOOGLE_SCOPES: 'https://www.googleapis.com/auth/gmail.readonly',
  };

  function build(): URL {
    const service = new AuthService(makeConfig(env));
    return new URL(service.buildGoogleAuthUrl());
  }

  it('targets the Google OAuth consent endpoint', () => {
    const url = build();
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
  });

  it('includes client_id, redirect_uri and scope from config', () => {
    const params = build().searchParams;
    expect(params.get('client_id')).toBe(env.GOOGLE_CLIENT_ID);
    expect(params.get('redirect_uri')).toBe(env.GOOGLE_REDIRECT_URI);
    expect(params.get('scope')).toBe(env.GOOGLE_SCOPES);
  });

  it('requests an offline authorization code with forced consent', () => {
    const params = build().searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('access_type')).toBe('offline');
    expect(params.get('prompt')).toBe('consent');
  });

  it('throws when a required OAuth env var is missing', () => {
    const service = new AuthService(makeConfig({ GOOGLE_CLIENT_ID: 'x' }));
    expect(() => service.buildGoogleAuthUrl()).toThrow();
  });
});
