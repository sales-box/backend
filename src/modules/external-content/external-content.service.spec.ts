import { Logger } from '@nestjs/common';
import { ExternalContentService } from './external-content.service';
import type {
  LinkDetectorResolver,
  DetectedLink,
} from './resolvers/link-detector.resolver';
import type { GoogleDriveResolver } from './resolvers/google-drive.resolver';
import type { ExternalContentStorageService } from './storage/external-content-storage.service';

const driveLink = (
  ref = 'https://drive.google.com/file/d/ABC1234567890/view',
): DetectedLink => ({
  originalRef: ref,
  domain: 'drive.google.com',
  classification: 'google_drive',
  allowed: true,
  parseFailed: false,
});

const unlisted: DetectedLink = {
  originalRef: 'https://evil.com/x',
  domain: 'evil.com',
  classification: 'unknown_link',
  allowed: false,
  parseFailed: false,
};

const broken: DetectedLink = {
  originalRef: 'https://[bad',
  domain: '',
  classification: 'unknown_link',
  allowed: false,
  parseFailed: true,
};

describe('ExternalContentService', () => {
  let service: ExternalContentService;
  let detect: jest.Mock;
  let getAdminAuth: jest.Mock;
  let fetchRaw: jest.Mock;
  let extractFileId: jest.Mock;
  let buildObjectKey: jest.Mock;
  let store: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    detect = jest.fn();
    getAdminAuth = jest.fn().mockResolvedValue({});
    fetchRaw = jest.fn();
    extractFileId = jest.fn().mockReturnValue('ABC1234567890');
    buildObjectKey = jest.fn().mockReturnValue('resolved/int/ABC-hash.pdf');
    store = jest.fn();

    const detector = { detect } as unknown as LinkDetectorResolver;
    const drive = {
      getAdminAuth,
      fetchRaw,
      extractFileId,
    } as unknown as GoogleDriveResolver;
    const storage = {
      buildObjectKey,
      store,
    } as unknown as ExternalContentStorageService;
    service = new ExternalContentService(detector, drive, storage);
  });

  it('S2-V7: unlisted domain → unrecognized_domain, Drive + S3 never touched', async () => {
    detect.mockResolvedValue([unlisted]);

    const [r] = await service.resolveExternalContent('body', 'int');

    expect(r).toMatchObject({
      sourceType: 'unknown_link',
      fetched: false,
      skipped: true,
      reason: 'unrecognized_domain',
    });
    expect(r.summary).toBeUndefined();
    expect(getAdminAuth).not.toHaveBeenCalled();
    expect(fetchRaw).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it('S2-V8: valid Drive link + token → fetched + stored, rawStorageKey present', async () => {
    detect.mockResolvedValue([driveLink()]);
    fetchRaw.mockResolvedValue({
      bytes: Buffer.from('pdf'),
      contentType: 'application/pdf',
    });
    store.mockResolvedValue('resolved/int/ABC-hash.pdf');

    const [r] = await service.resolveExternalContent('body', 'int');

    expect(r).toMatchObject({
      sourceType: 'google_drive',
      fetched: true,
      skipped: false,
      rawStorageKey: 'resolved/int/ABC-hash.pdf',
    });
    expect(r.reason).toBeUndefined();
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('S2-V9: expired/invalid token (fetchRaw null) → fetch_failed, no throw, no store', async () => {
    detect.mockResolvedValue([driveLink()]);
    fetchRaw.mockResolvedValue(null);

    const [r] = await service.resolveExternalContent('body', 'int');

    expect(r).toMatchObject({
      fetched: false,
      skipped: true,
      reason: 'fetch_failed',
    });
    expect(store).not.toHaveBeenCalled();
  });

  it('3-link mixed batch → 3 correct results, no crash', async () => {
    detect.mockResolvedValue([driveLink(), unlisted, broken]);
    fetchRaw.mockResolvedValue({
      bytes: Buffer.from('pdf'),
      contentType: 'application/pdf',
    });
    store.mockResolvedValue('resolved/int/ABC-hash.pdf');

    const res = await service.resolveExternalContent('body', 'int');

    expect(res).toHaveLength(3);
    expect(res[0]).toMatchObject({
      fetched: true,
      rawStorageKey: 'resolved/int/ABC-hash.pdf',
    });
    expect(res[1]).toMatchObject({
      reason: 'unrecognized_domain',
      fetched: false,
    });
    expect(res[2]).toMatchObject({ reason: 'parse_error', fetched: false });
    expect(store).toHaveBeenCalledTimes(1); // only the Drive link
  });

  it('storage failure → fetched:true but rawStorageKey undefined + fetch_failed', async () => {
    detect.mockResolvedValue([driveLink()]);
    fetchRaw.mockResolvedValue({
      bytes: Buffer.from('pdf'),
      contentType: 'application/pdf',
    });
    store.mockResolvedValue(undefined);

    const [r] = await service.resolveExternalContent('body', 'int');

    expect(r).toMatchObject({
      fetched: true,
      skipped: false,
      rawStorageKey: undefined,
      reason: 'fetch_failed',
    });
  });

  it('systemic auth outage → all Drive links fetch_failed with exactly one ERROR', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    detect.mockResolvedValue([
      driveLink(),
      driveLink('https://drive.google.com/file/d/XYZ1234567890/view'),
    ]);
    getAdminAuth.mockResolvedValue(null);

    const res = await service.resolveExternalContent('body', 'int');

    expect(res.every((r) => r.reason === 'fetch_failed')).toBe(true);
    expect(fetchRaw).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('per-link isolation: one throwing link does not break the others', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    detect.mockResolvedValue([
      driveLink('https://drive.google.com/file/d/AAAAAAAAAAAA/view'),
      driveLink('https://drive.google.com/file/d/BBBBBBBBBBBB/view'),
    ]);
    fetchRaw
      .mockImplementationOnce(() => {
        throw new Error('boom');
      })
      .mockResolvedValueOnce({
        bytes: Buffer.from('pdf'),
        contentType: 'application/pdf',
      });
    store.mockResolvedValue('resolved/int/ABC-hash.pdf');

    const res = await service.resolveExternalContent('body', 'int');

    expect(res).toHaveLength(2);
    expect(res.filter((r) => r.reason === 'fetch_failed')).toHaveLength(1);
    expect(res.filter((r) => r.fetched)).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it('Drive URL with no file id (e.g. a /folders/ link) → parse_error, not fetched', async () => {
    detect.mockResolvedValue([
      driveLink('https://drive.google.com/drive/folders/1hlpy_MZmMINe'),
    ]);
    extractFileId.mockReturnValue(null);

    const [r] = await service.resolveExternalContent('body', 'int');

    expect(r).toMatchObject({ reason: 'parse_error', fetched: false });
    expect(r.detail).toMatch(/folder/i);
    expect(fetchRaw).not.toHaveBeenCalled();
  });

  it('allow-listed non-Drive host → not_attempted (never fetched)', async () => {
    detect.mockResolvedValue([
      {
        originalRef: 'https://partner.example.com/doc',
        domain: 'partner.example.com',
        classification: 'unknown_link',
        allowed: true,
        parseFailed: false,
      },
    ]);

    const [r] = await service.resolveExternalContent('body', 'int');

    expect(r).toMatchObject({
      reason: 'not_attempted',
      fetched: false,
      skipped: true,
    });
    expect(getAdminAuth).not.toHaveBeenCalled();
    expect(fetchRaw).not.toHaveBeenCalled();
  });

  it('summary is always undefined', async () => {
    detect.mockResolvedValue([driveLink(), unlisted]);
    fetchRaw.mockResolvedValue({
      bytes: Buffer.from('x'),
      contentType: 'application/pdf',
    });
    store.mockResolvedValue('k');

    const res = await service.resolveExternalContent('body', 'int');
    expect(res.every((r) => r.summary === undefined)).toBe(true);
  });

  // ── Sprint 3 baseline: tenant isolation flows through the orchestrator ──

  it('S3-V10: threads the tenantId into the allow-list lookup', async () => {
    detect.mockResolvedValue([unlisted]);

    await service.resolveExternalContent('body', 'int', 'tenant-a');

    expect(detect).toHaveBeenCalledWith('body', 'tenant-a');
  });

  it('S3-V10: requests the Drive connection for the calling tenant only', async () => {
    detect.mockResolvedValue([driveLink()]);
    fetchRaw.mockResolvedValue({
      bytes: Buffer.from('x'),
      contentType: 'application/pdf',
    });
    store.mockResolvedValue('k');

    await service.resolveExternalContent('body', 'int', 'tenant-a');

    expect(getAdminAuth).toHaveBeenCalledWith('tenant-a');
  });

  it('S3-V10: tenant without a Drive connection → fetch_failed, never a fallback', async () => {
    detect.mockResolvedValue([driveLink()]);
    getAdminAuth.mockResolvedValue(null); // no connection for THIS tenant

    const res = await service.resolveExternalContent('body', 'int', 'tenant-b');

    expect(res[0]).toMatchObject({
      fetched: false,
      skipped: true,
      reason: 'fetch_failed',
    });
    expect(getAdminAuth).toHaveBeenCalledWith('tenant-b');
    expect(fetchRaw).not.toHaveBeenCalled();
  });

  it('legacy call without a tenant passes undefined through both lookups', async () => {
    detect.mockResolvedValue([driveLink()]);
    fetchRaw.mockResolvedValue({
      bytes: Buffer.from('x'),
      contentType: 'application/pdf',
    });
    store.mockResolvedValue('k');

    await service.resolveExternalContent('body', 'int');

    expect(detect).toHaveBeenCalledWith('body', undefined);
    expect(getAdminAuth).toHaveBeenCalledWith(undefined);
  });
});
