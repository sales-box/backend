import type { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import type { PrismaService } from '../../database/prisma.service';
import type { CryptoService } from '../auth/crypto.service';
import { ExternalContentService } from './external-content.service';
import { LinkDetectorResolver } from './resolvers/link-detector.resolver';
import { GoogleDriveResolver } from './resolvers/google-drive.resolver';
import { ExternalContentStorageService } from './storage/external-content-storage.service';

// The only outbound byte path is these two SDKs — both mocked here so NO real
// network happens. Combined with the eslint no-restricted-imports ban on
// http/https/axios/fetch in the module source, this proves our code never
// performs a raw fetch on a client-supplied URL.
const filesGet = jest.fn();
const setCredentials = jest.fn();
jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials })) },
    drive: jest.fn(() => ({ files: { get: filesGet, export: jest.fn() } })),
  },
}));

const s3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: s3Send })),
  PutObjectCommand: jest
    .fn()
    .mockImplementation((input: Record<string, unknown>) => ({ input })),
}));

describe('external-content — behavioral no-raw-fetch invariant', () => {
  it('resolves a mixed batch with zero raw fetch — only the Drive SDK path', async () => {
    const originalFetch = (globalThis as { fetch?: unknown }).fetch;
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const config = {
      getOrThrow: (k: string): string =>
        ({
          GOOGLE_CLIENT_ID: 'id',
          GOOGLE_CLIENT_SECRET: 'sec',
          GOOGLE_REDIRECT_URI: 'http://cb',
          S3_BUCKET: 'salesbox-iti',
          AWS_REGION: 'eu-north-1',
        })[k] ?? '',
      get: (): undefined => undefined,
    } as unknown as ConfigService;

    const prisma = {
      allowedDomain: {
        findUnique: jest.fn(({ where }: { where: { domain: string } }) =>
          Promise.resolve(
            where.domain === 'drive.google.com' ? { id: 'x' } : null,
          ),
        ),
      },
      driveConnection: {
        findFirst: jest.fn().mockResolvedValue({
          accessToken: 'enc',
          refreshToken: 'enc',
          tokenExpiresAt: null,
          status: 'connected',
        }),
      },
    } as unknown as PrismaService;
    const crypto = {
      decrypt: jest.fn(() => 'tok'),
    } as unknown as CryptoService;

    filesGet.mockImplementation((params: { alt?: string }) =>
      params.alt === 'media'
        ? Promise.resolve({ data: Readable.from([Buffer.from('bytes')]) })
        : Promise.resolve({ data: { mimeType: 'application/pdf' } }),
    );
    s3Send.mockResolvedValue({});

    const service = new ExternalContentService(
      new LinkDetectorResolver(prisma),
      new GoogleDriveResolver(config, prisma, crypto),
      new ExternalContentStorageService(config),
    );

    const body =
      'https://drive.google.com/file/d/ABC1234567890/view ' +
      'https://evil.com/x ' +
      'https://[bad';
    const res = await service.resolveExternalContent(body, 'int-1');

    expect(res).toHaveLength(3);
    expect(res[0].fetched).toBe(true);
    expect(res[1].reason).toBe('unrecognized_domain');
    expect(res[2].reason).toBe('parse_error');

    // no raw fetch; the only fetch path used was the Google Drive SDK
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(filesGet).toHaveBeenCalled();

    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  });
});
