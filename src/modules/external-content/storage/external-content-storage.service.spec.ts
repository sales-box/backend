import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ExternalContentStorageService } from './external-content-storage.service';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest
    .fn()
    .mockImplementation((input: Record<string, unknown>) => ({ input })),
}));

interface PutInput {
  Bucket: string;
  Key: string;
  Body: Buffer;
  ContentType?: string;
  ServerSideEncryption?: string;
  ACL?: string;
}

function firstPutInput(): PutInput {
  const calls = (PutObjectCommand as unknown as jest.Mock).mock.calls as Array<
    [PutInput]
  >;
  return calls[0][0];
}

describe('ExternalContentStorageService', () => {
  let service: ExternalContentStorageService;
  let errorSpy: jest.SpyInstance;

  const config = {
    getOrThrow: (key: string): string =>
      ({ S3_BUCKET: 'salesbox-iti', AWS_REGION: 'eu-north-1' })[key] ?? '',
    get: (): undefined => undefined, // no S3_ENDPOINT (real AWS)
  } as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    service = new ExternalContentStorageService(config);
  });

  it('uploads with AES256, no ACL, and the exact fetched buffer', async () => {
    mockSend.mockResolvedValueOnce({});
    const bytes = Buffer.from('raw-file-bytes');

    const key = await service.store(
      bytes,
      'resolved/i1/f1-abc.pdf',
      'application/pdf',
    );

    expect(key).toBe('resolved/i1/f1-abc.pdf');
    expect(mockSend).toHaveBeenCalledTimes(1);
    const put = firstPutInput();
    expect(put.Bucket).toBe('salesbox-iti');
    expect(put.ServerSideEncryption).toBe('AES256');
    expect(put.Body).toBe(bytes); // exact buffer, not a copy
    expect(put).not.toHaveProperty('ACL');
  });

  it('returns undefined and logs an error on S3 failure — never throws', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { name: 'AccessDenied' }),
    );

    const key = await service.store(
      Buffer.from('x'),
      'resolved/i1/f1.bin',
      'application/octet-stream',
    );

    expect(key).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // log carries the error name, never the raw message
    const firstArg = (errorSpy.mock.calls as unknown[][])[0][0];
    expect(String(firstArg)).toContain('AccessDenied');
    expect(String(firstArg)).not.toContain('boom');
  });

  it('builds collision-resistant keys — different bytes → different key', () => {
    const a = service.buildObjectKey(
      'int-1',
      'fileA',
      Buffer.from('one'),
      'pdf',
    );
    const b = service.buildObjectKey(
      'int-1',
      'fileA',
      Buffer.from('two'),
      'pdf',
    );
    expect(a).not.toBe(b);
    expect(a.startsWith('resolved/int-1/fileA-')).toBe(true);
    expect(a.endsWith('.pdf')).toBe(true);
  });

  it('sanitizes hostile path segments in the key', () => {
    const key = service.buildObjectKey(
      '../../etc',
      'a/b/../c',
      Buffer.from('z'),
      'p d f!',
    );
    expect(key).not.toContain('..');
    const segments = key.split('/');
    expect(segments).toHaveLength(3); // resolved / <interaction> / <file>-<hash>.<ext>
    expect(segments.every((s) => s.length > 0)).toBe(true);
  });
});
