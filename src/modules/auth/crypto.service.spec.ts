import { ConfigService } from '@nestjs/config';
import { CryptoService } from './crypto.service';

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

function build(key: string = KEY): CryptoService {
  return new CryptoService(makeConfig({ TOKEN_ENCRYPTION_KEY: key }));
}

describe('CryptoService', () => {
  it('produces ciphertext that hides the plaintext', () => {
    const crypto = build();
    const plaintext = 'ya29.super-secret-access-token';

    const encrypted = crypto.encrypt(plaintext);

    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).not.toContain(plaintext);
  });

  it('uses the v1:iv:tag:ct envelope', () => {
    const parts = build().encrypt('secret').split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(parts[1].length).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
    expect(parts[3].length).toBeGreaterThan(0);
  });

  it('round-trips short and long tokens', () => {
    const crypto = build();
    const short = 'ya29.short';
    const long = '1//' + 'x'.repeat(512);

    expect(crypto.decrypt(crypto.encrypt(short))).toBe(short);
    expect(crypto.decrypt(crypto.encrypt(long))).toBe(long);
  });

  it('round-trips with a hex-encoded key', () => {
    const crypto = build('a'.repeat(64));
    expect(crypto.decrypt(crypto.encrypt('secret'))).toBe('secret');
  });

  it('produces a fresh IV each call', () => {
    const crypto = build();
    const plaintext = 'same-token';

    const a = crypto.encrypt(plaintext);
    const b = crypto.encrypt(plaintext);

    expect(a).not.toBe(b);
    expect(crypto.decrypt(a)).toBe(plaintext);
    expect(crypto.decrypt(b)).toBe(plaintext);
  });

  it('fails closed when the ciphertext is tampered', () => {
    const crypto = build();
    const parts = crypto.encrypt('secret').split(':');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 0xff;
    parts[3] = ct.toString('base64');

    expect(() => crypto.decrypt(parts.join(':'))).toThrow();
  });

  it('rejects a malformed envelope', () => {
    const crypto = build();
    expect(() => crypto.decrypt('not-an-envelope')).toThrow(
      /Malformed encrypted payload/,
    );
    expect(() => crypto.decrypt('v1:only:three')).toThrow(
      /Malformed encrypted payload/,
    );
    expect(() => crypto.decrypt('v2:a:b:c')).toThrow(
      /Malformed encrypted payload/,
    );
  });

  it('rejects a key that does not decode to 32 bytes', () => {
    const shortKey = Buffer.alloc(16, 'k').toString('base64');
    expect(() => build(shortKey)).toThrow();
  });
});
