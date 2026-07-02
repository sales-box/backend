import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const VERSION = 'v1';

/**
 * Authenticated AES-256-GCM encryption for secrets stored at rest.
 * Envelope: `v1:base64(iv):base64(authTag):base64(ciphertext)`.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = CryptoService.decodeKey(
      config.getOrThrow<string>('TOKEN_ENCRYPTION_KEY'),
    );
    if (this.key.length !== KEY_BYTES) {
      throw new Error(
        `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${this.key.length}`,
      );
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [
      VERSION,
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('Malformed encrypted payload');
    }
    const iv = Buffer.from(parts[1], 'base64');
    const authTag = Buffer.from(parts[2], 'base64');
    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
      throw new Error('Malformed encrypted payload');
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Accepts a base64- or hex-encoded key. */
  private static decodeKey(raw: string): Buffer {
    return /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
  }
}
