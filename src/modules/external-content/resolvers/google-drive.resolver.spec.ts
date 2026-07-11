import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import type { PrismaService } from '../../../database/prisma.service';
import type { CryptoService } from '../../auth/crypto.service';
import { GoogleDriveResolver } from './google-drive.resolver';
import { MAX_EXTERNAL_FILE_BYTES } from '../external-content.constants';

const filesGet = jest.fn();
const filesExport = jest.fn();
const setCredentials = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials })) },
    drive: jest.fn(() => ({ files: { get: filesGet, export: filesExport } })),
  },
}));

const streamOf = (buf: Buffer): Readable => Readable.from([buf]);
const DRIVE_URL = 'https://drive.google.com/file/d/ABC123DEF456GHI/view';
const fakeAuth = {} as unknown as Parameters<
  GoogleDriveResolver['fetchRaw']
>[1];

describe('GoogleDriveResolver', () => {
  let resolver: GoogleDriveResolver;
  let findFirst: jest.Mock;
  let decrypt: jest.Mock;

  const config = {
    getOrThrow: (k: string): string =>
      ({
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'sec',
        GOOGLE_REDIRECT_URI: 'http://cb',
      })[k] ?? '',
  } as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    findFirst = jest.fn().mockResolvedValue({
      accessToken: 'enc-a',
      refreshToken: 'enc-r',
      tokenExpiresAt: null,
      status: 'connected',
    });
    decrypt = jest.fn((s: string) => `dec(${s})`);
    const prisma = {
      driveConnection: { findFirst },
    } as unknown as PrismaService;
    const crypto = { decrypt } as unknown as CryptoService;
    resolver = new GoogleDriveResolver(config, prisma, crypto);
  });

  it.each([
    [
      'file/d',
      'https://drive.google.com/file/d/ABC123DEF456GHI/view',
      'ABC123DEF456GHI',
    ],
    [
      'document/d',
      'https://docs.google.com/document/d/DOC1234567890/edit',
      'DOC1234567890',
    ],
    [
      'open?id',
      'https://drive.google.com/open?id=OPEN123456789',
      'OPEN123456789',
    ],
  ])('extractFileId: %s', (_l, url, expected) => {
    expect(resolver.extractFileId(new URL(url))).toBe(expected);
  });

  it('extractFileId rejects too-short and too-long ids', () => {
    expect(
      resolver.extractFileId(new URL('https://drive.google.com/open?id=short')),
    ).toBeNull();
    const huge = 'A'.repeat(200);
    expect(
      resolver.extractFileId(
        new URL(`https://drive.google.com/open?id=${huge}`),
      ),
    ).toBeNull();
  });

  describe('getAdminAuth', () => {
    it('returns null when no admin connection exists', async () => {
      findFirst.mockResolvedValue(null);
      expect(await resolver.getAdminAuth()).toBeNull();
    });

    it('returns null when token decryption fails', async () => {
      decrypt.mockImplementation(() => {
        throw new Error('bad key');
      });
      expect(await resolver.getAdminAuth()).toBeNull();
    });

    it('builds an OAuth client with the decrypted admin tokens', async () => {
      const auth = await resolver.getAdminAuth();
      expect(auth).not.toBeNull();
      expect(setCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          access_token: 'dec(enc-a)',
          refresh_token: 'dec(enc-r)',
        }),
      );
    });

    it('looks up ONLY the calling tenant connection — never another tenant (S3-V10)', async () => {
      await resolver.getAdminAuth('tenant-b');
      expect(findFirst).toHaveBeenCalledWith({
        where: { status: 'connected', tenantId: 'tenant-b' },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('legacy callers (no tenant) only match the pre-tenant NULL row', async () => {
      await resolver.getAdminAuth();
      expect(findFirst).toHaveBeenCalledWith({
        where: { status: 'connected', tenantId: null },
        orderBy: { createdAt: 'asc' },
      });
    });
  });

  it('fetches a binary file via alt=media (S2-V8)', async () => {
    filesGet.mockImplementation((params: { alt?: string }) =>
      params.alt === 'media'
        ? Promise.resolve({ data: streamOf(Buffer.from('pdf-bytes')) })
        : Promise.resolve({ data: { mimeType: 'application/pdf' } }),
    );

    const out = await resolver.fetchRaw(new URL(DRIVE_URL), fakeAuth);

    expect(out?.contentType).toBe('application/pdf');
    expect(out?.bytes.toString()).toBe('pdf-bytes');
    expect(filesExport).not.toHaveBeenCalled();
  });

  it('exports a native Google Doc via files.export, never alt=media', async () => {
    filesGet.mockResolvedValue({
      data: { mimeType: 'application/vnd.google-apps.document' },
    });
    filesExport.mockResolvedValue({ data: streamOf(Buffer.from('exported')) });

    const out = await resolver.fetchRaw(
      new URL('https://docs.google.com/document/d/DOC1234567890/edit'),
      fakeAuth,
    );

    expect(out?.contentType).toBe('application/pdf');
    expect(filesExport).toHaveBeenCalledTimes(1);
    expect(filesGet).toHaveBeenCalledTimes(1); // meta only, never media
  });

  it('returns null + warns on an expired/invalid token — never throws (S2-V9)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    filesGet.mockRejectedValue(
      Object.assign(new Error('bad'), { name: 'invalid_grant' }),
    );

    const out = await resolver.fetchRaw(new URL(DRIVE_URL), fakeAuth);

    expect(out).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('aborts and returns null when the stream exceeds the byte cap', async () => {
    const oversized = Buffer.alloc(MAX_EXTERNAL_FILE_BYTES + 16);
    filesGet.mockImplementation((params: { alt?: string }) =>
      params.alt === 'media'
        ? Promise.resolve({ data: streamOf(oversized) })
        : Promise.resolve({ data: { mimeType: 'application/pdf' } }),
    );

    const out = await resolver.fetchRaw(new URL(DRIVE_URL), fakeAuth);
    expect(out).toBeNull();
  });

  it('returns null for a URL with no extractable file id (no fetch attempted)', async () => {
    const out = await resolver.fetchRaw(
      new URL('https://drive.google.com/'),
      fakeAuth,
    );
    expect(out).toBeNull();
    expect(filesGet).not.toHaveBeenCalled();
  });
});
