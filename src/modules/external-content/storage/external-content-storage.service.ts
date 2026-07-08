import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { EXTERNAL_CONTENT_TIMEOUT_MS } from '../external-content.constants';
import { errName } from '../external-content.util';

/**
 * Thin S3 wrapper for the external content resolver (US-043). Uploads raw
 * fetched bytes; on failure it logs loudly and returns undefined instead of
 * throwing, so one failed store never breaks the rest of email processing.
 */
@Injectable()
export class ExternalContentStorageService {
  private readonly logger = new Logger(ExternalContentStorageService.name);
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.getOrThrow<string>('S3_BUCKET');
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    this.client = new S3Client({
      region: this.config.getOrThrow<string>('AWS_REGION'),
      // Credentials come from the default provider chain (env / IAM role) —
      // never passed as literals. S3_ENDPOINT is only set for LocalStack.
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
  }

  /**
   * Deterministic, collision-resistant key: the content hash makes two
   * different payloads produce different keys even under the same interaction,
   * and re-storing identical bytes is idempotent.
   */
  buildObjectKey(
    interactionId: string,
    fileId: string,
    bytes: Buffer,
    ext: string,
  ): string {
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const safeInteraction =
      interactionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown';
    const safeFileId =
      fileId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128) || 'file';
    const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'bin';
    return `resolved/${safeInteraction}/${safeFileId}-${hash}.${safeExt}`;
  }

  /** Returns the key on success, or undefined on any failure (never throws). */
  async store(
    bytes: Buffer,
    key: string,
    contentType: string,
  ): Promise<string | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      EXTERNAL_CONTENT_TIMEOUT_MS,
    );
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          // Server-side encryption on every put; no ACL (bucket-owner-enforced).
          ServerSideEncryption: 'AES256',
        }),
        { abortSignal: controller.signal },
      );
      return key;
    } catch (err) {
      // Loud: a lost write means we can never recover this file. Name/code only.
      this.logger.error(`S3 PutObject failed key=${key} err=${errName(err)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
