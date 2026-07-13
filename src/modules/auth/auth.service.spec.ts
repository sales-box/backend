/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import {
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as googleapis from 'googleapis';
import { PrismaService } from '../../database/prisma.service';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { AllowlistService } from '../allowlist/allowlist.service';
import { JwtService } from '@nestjs/jwt';

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
const OAuth2Mock = (googleapis.google.auth as unknown as { OAuth2: jest.Mock })
  .OAuth2;

function makeConfig(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string): string => {
      const value = values[key];
      if (value === undefined) throw new Error(`Missing config: ${key}`);
      return value;
    },
  } as unknown as ConfigService;
}

const KEY = Buffer.alloc(32, 'k').toString('base64');
const env = {
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
  GOOGLE_SCOPES: 'https://www.googleapis.com/auth/gmail.readonly',
};

describe('AuthService buildGoogleAuthUrl', () => {
  function build(state?: string): URL {
    const service = new AuthService(
      makeConfig(env),
      {} as PrismaService,
      {} as CryptoService,
      { verifyAccess: jest.fn() } as unknown as AllowlistService,
      { emit: jest.fn() } as any,
      { signAsync: jest.fn() } as unknown as JwtService,
    );
    return new URL(service.buildGoogleAuthUrl(state));
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

  it('carries the CSRF state param when provided, omits it otherwise', () => {
    expect(build('csrf-state-123').searchParams.get('state')).toBe(
      'csrf-state-123',
    );
    expect(build().searchParams.has('state')).toBe(false);
  });

  it('throws when a required OAuth env var is missing', () => {
    const service = new AuthService(
      makeConfig({ GOOGLE_CLIENT_ID: 'x' }),
      {} as PrismaService,
      {} as CryptoService,
      { verifyAccess: jest.fn() } as unknown as AllowlistService,
      { emit: jest.fn() } as any,
      { signAsync: jest.fn() } as unknown as JwtService,
    );
    expect(() => service.buildGoogleAuthUrl()).toThrow();
  });
});

describe('AuthService handleGoogleCallback', () => {
  const ACCESS = 'ACCESS_Trap_123';
  const REFRESH = 'REFRESH_Trap_456';
  const CODE = 'auth-code-xyz';
  const EMAIL = 'seller@example.com';
  const EXPIRY = 1893456000000;

  let prisma: PrismaService;
  let findFirst: jest.Mock;
  let update: jest.Mock;
  let create: jest.Mock;
  let crypto: CryptoService;
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    findFirst = jest.fn().mockResolvedValue(null);
    update = jest.fn().mockResolvedValue({ id: 'mock-id', email: EMAIL });
    create = jest.fn().mockResolvedValue({ id: 'mock-id', email: EMAIL });
    prisma = {
      connectedAccount: { findFirst, update, create },
    } as unknown as PrismaService;
    crypto = new CryptoService(makeConfig({ TOKEN_ENCRYPTION_KEY: KEY }));
    service = new AuthService(
      makeConfig(env),
      prisma,
      crypto,
      { verifyAccess: jest.fn() } as unknown as AllowlistService,
      { emit: jest.fn() } as any,
      { signAsync: jest.fn() } as unknown as JwtService,
    );
  });

  function happyTokens(overrides: Record<string, unknown> = {}) {
    gmocks.getToken.mockResolvedValue({
      tokens: {
        access_token: ACCESS,
        refresh_token: REFRESH,
        expiry_date: EXPIRY,
        scope: env.GOOGLE_SCOPES,
        ...overrides,
      },
    });
    gmocks.getProfile.mockResolvedValue({ data: { emailAddress: EMAIL } });
  }

  it('exchanges the code and creates an encrypted account if it does not exist', async () => {
    happyTokens();

    const result = await service.handleGoogleCallback(CODE);

    expect(result).toEqual({ email: EMAIL });
    expect(gmocks.getToken).toHaveBeenCalledWith(CODE);
    expect(OAuth2Mock).toHaveBeenCalledWith(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_REDIRECT_URI,
    );
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();

    const arg = create.mock.calls[0][0];
    expect(arg.data.email).toEqual(EMAIL);
    expect(arg.data.status).toBe('connected');
    expect(arg.data.scope).toBe(env.GOOGLE_SCOPES);
    expect(arg.data.tokenExpiresAt).toEqual(new Date(EXPIRY));
  });

  it('admin callback is NOT allowlist-gated — the allowlist is the SE guest list', async () => {
    happyTokens();

    // Even a bouncer that would refuse must never be consulted on the admin
    // path: connecting Google grants no privileges by itself (privileges come
    // from set-password), while SE login stays strictly gated.
    const verifyAccess = jest
      .fn()
      .mockRejectedValue(new ForbiddenException('not on allowlist'));
    service = new AuthService(
      makeConfig(env),
      prisma,
      crypto,
      { verifyAccess } as unknown as AllowlistService,
      { emit: jest.fn() } as any,
      { signAsync: jest.fn() } as unknown as JwtService,
    );

    const result = await service.handleGoogleCallback(CODE);

    expect(result).toEqual({ email: EMAIL });
    expect(verifyAccess).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('mints an admin JWT when the account is an established admin', async () => {
    happyTokens();
    // The account already went through set-password: admin with a hash.
    update.mockResolvedValue({
      id: 'acct-admin',
      email: EMAIL,
      tenantId: 'tenant-a',
      isAdmin: true,
      passwordHash: '$argon2id$stored-hash',
    });
    findFirst.mockResolvedValue({ id: 'acct-admin', email: EMAIL });
    const signAsync = jest.fn().mockResolvedValue('signed.admin.jwt');
    service = new AuthService(
      makeConfig(env),
      prisma,
      crypto,
      { verifyAccess: jest.fn() } as unknown as AllowlistService,
      { emit: jest.fn() } as any,
      { signAsync } as unknown as JwtService,
    );

    const result = await service.handleGoogleCallback(CODE);

    expect(result).toEqual({
      email: EMAIL,
      adminToken: 'signed.admin.jwt',
      tenantId: 'tenant-a',
    });
    // Same claim shape as /auth/admin/login, module-default TTL (no override).
    expect(signAsync).toHaveBeenCalledWith({
      sub: 'acct-admin',
      tenantId: 'tenant-a',
      isAdmin: true,
      email: EMAIL,
    });
  });

  it('does NOT mint a token for an admin who has no password yet', async () => {
    happyTokens();
    update.mockResolvedValue({
      id: 'acct-1',
      email: EMAIL,
      tenantId: 'tenant-a',
      isAdmin: true,
      passwordHash: null, // set-password not done yet
    });
    findFirst.mockResolvedValue({ id: 'acct-1', email: EMAIL });
    const signAsync = jest.fn();
    service = new AuthService(
      makeConfig(env),
      prisma,
      crypto,
      { verifyAccess: jest.fn() } as unknown as AllowlistService,
      { emit: jest.fn() } as any,
      { signAsync } as unknown as JwtService,
    );

    const result = await service.handleGoogleCallback(CODE);

    expect(result).toEqual({ email: EMAIL });
    expect(signAsync).not.toHaveBeenCalled();
  });

  it('seLoginWithGoogle signs the canonical claim shape with an SE TTL', async () => {
    happyTokens();
    // The upserted account is what the SE claims are built from.
    create.mockResolvedValue({
      id: 'acct-1',
      email: EMAIL,
      tenantId: 'tenant-1',
      isAdmin: false,
    });
    const signAsync = jest.fn().mockResolvedValue('signed.jwt.token');
    // verifyAccess returns the tenant the SE was granted under.
    const verifyAccess = jest.fn().mockResolvedValue({ tenantId: 'tenant-1' });
    service = new AuthService(
      makeConfig(env),
      prisma,
      crypto,
      { verifyAccess } as unknown as AllowlistService,
      { emit: jest.fn() } as any,
      { signAsync } as unknown as JwtService,
    );

    const result = await service.seLoginWithGoogle(CODE);

    expect(result).toEqual({ token: 'signed.jwt.token' });
    // The allowlist tenant is stamped on the account, so tenant-scoped
    // revoke/offboard can reach it later.
    expect(create.mock.calls[0][0].data.tenantId).toBe('tenant-1');
    // { sub, tenantId, isAdmin, email } — same shape the JwtAuthGuard verifies.
    expect(signAsync).toHaveBeenCalledWith(
      { sub: 'acct-1', tenantId: 'tenant-1', isAdmin: false, email: EMAIL },
      { expiresIn: '7d' },
    );
    expect(create).toHaveBeenCalledTimes(1); // account upserted
  });

  it('an SE login never mints an admin token, even for an isAdmin row', async () => {
    happyTokens();
    create.mockResolvedValue({
      id: 'acct-1',
      email: EMAIL,
      tenantId: 'tenant-1',
      isAdmin: true, // row is an admin...
    });
    const signAsync = jest.fn().mockResolvedValue('t');
    const verifyAccess = jest.fn().mockResolvedValue({ tenantId: 'tenant-1' });
    service = new AuthService(
      makeConfig(env),
      prisma,
      crypto,
      { verifyAccess } as unknown as AllowlistService,
      { emit: jest.fn() } as any,
      { signAsync } as unknown as JwtService,
    );

    await service.seLoginWithGoogle(CODE);

    // ...but the SE session token is forced to isAdmin: false.
    expect(signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ isAdmin: false }),
      { expiresIn: '7d' },
    );
  });

  it('seLoginWithGoogle returns invalid_allowlist for a non-allowlisted email', async () => {
    happyTokens();
    const verifyAccess = jest.fn().mockRejectedValue(new ForbiddenException());
    const signAsync = jest.fn();
    service = new AuthService(
      makeConfig(env),
      prisma,
      crypto,
      { verifyAccess } as unknown as AllowlistService,
      { emit: jest.fn() } as any,
      { signAsync } as unknown as JwtService,
    );

    const result = await service.seLoginWithGoogle(CODE);

    expect(result).toEqual({ error: 'invalid_allowlist' });
    expect(signAsync).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled(); // no account saved
  });

  it('stores tokens as ciphertext that decrypts back to the originals', async () => {
    happyTokens();

    await service.handleGoogleCallback(CODE);
    const arg = create.mock.calls[0][0];

    expect(arg.data.accessToken).not.toBe(ACCESS);
    expect(arg.data.refreshToken).not.toBe(REFRESH);
    expect(crypto.decrypt(arg.data.accessToken)).toBe(ACCESS);
    expect(crypto.decrypt(arg.data.refreshToken)).toBe(REFRESH);
  });

  it('throws BadRequestException and skips DB calls when the code is invalid', async () => {
    gmocks.getToken.mockRejectedValue(new Error('invalid_grant'));

    await expect(service.handleGoogleCallback(CODE)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('throws and skips DB calls when the profile lookup fails', async () => {
    gmocks.getToken.mockResolvedValue({ tokens: { access_token: ACCESS } });
    gmocks.getProfile.mockRejectedValue({
      response: {
        status: 403,
        data: { error: { status: 'PERMISSION_DENIED', message: 'disabled' } },
      },
    });

    await expect(service.handleGoogleCallback(CODE)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('throws BadRequestException for a missing code without calling Google', async () => {
    await expect(service.handleGoogleCallback('')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(gmocks.getToken).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('stores null expiry when Google omits expiry_date', async () => {
    happyTokens({ expiry_date: undefined });

    await service.handleGoogleCallback(CODE);

    expect(create.mock.calls[0][0].data.tokenExpiresAt).toBeNull();
  });

  it('does not overwrite a stored refresh token when re-consent omits it (update scenario)', async () => {
    findFirst.mockResolvedValue({ id: 'mock-id', email: EMAIL });
    happyTokens({ refresh_token: undefined });

    await service.handleGoogleCallback(CODE);

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];

    expect('refreshToken' in arg.data).toBe(false);
    expect(arg.data.accessToken).toBeDefined();
  });

  it('does not overwrite a stored scope when re-consent omits it (update scenario)', async () => {
    findFirst.mockResolvedValue({ id: 'mock-id', email: EMAIL });
    happyTokens({ scope: undefined });

    await service.handleGoogleCallback(CODE);

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];

    expect('scope' in arg.data).toBe(false);
  });

  it('throws and skips DB calls when the account email cannot be resolved', async () => {
    gmocks.getToken.mockResolvedValue({
      tokens: { access_token: ACCESS, refresh_token: REFRESH },
    });
    gmocks.getProfile.mockResolvedValue({ data: {} });

    await expect(service.handleGoogleCallback(CODE)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('never leaks tokens or the auth code to logs', async () => {
    const spies = [
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {}),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {}),
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {}),
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {}),
      jest.spyOn(console, 'log').mockImplementation(() => {}),
      jest.spyOn(console, 'error').mockImplementation(() => {}),
    ];

    happyTokens();
    await service.handleGoogleCallback(CODE);

    gmocks.getToken.mockRejectedValue(new Error(`boom ${ACCESS}`));
    await expect(service.handleGoogleCallback(CODE)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const output = spies
      .flatMap((s) => s.mock.calls)
      .flat()
      .map((a) => JSON.stringify(a))
      .join(' ');

    expect(output).not.toContain(ACCESS);
    expect(output).not.toContain(REFRESH);
    expect(output).not.toContain(CODE);

    spies.forEach((s) => s.mockRestore());
  });
});
