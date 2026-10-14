import { ForbiddenException } from '@nestjs/common';
import { buildGraphThreadId, assertOwnsGraphThread } from './graph-thread-id';

describe('reply graph checkpoint keys', () => {
  it('prefixes the key with the tenant', () => {
    expect(buildGraphThreadId('tenant-a', 'thr1', 'msg1')).toBe(
      'tenant-a:thr1:msg1',
    );
  });

  it('accepts a key that belongs to the caller', () => {
    expect(() =>
      assertOwnsGraphThread('tenant-a', 'tenant-a:thr1:msg1'),
    ).not.toThrow();
  });

  it("rejects another tenant's key", () => {
    expect(() =>
      assertOwnsGraphThread('tenant-a', 'tenant-b:thr1:msg1'),
    ).toThrow(ForbiddenException);
  });

  it('rejects a tenant whose id is only a prefix of the owner', () => {
    // 'tenant-a' must not be accepted for a key owned by 'tenant-abc'.
    expect(() =>
      assertOwnsGraphThread('tenant-a', 'tenant-abc:thr1:msg1'),
    ).toThrow(ForbiddenException);
  });

  it('rejects a legacy key that carries no tenant', () => {
    expect(() => assertOwnsGraphThread('tenant-a', 'thr1:msg1')).toThrow(
      ForbiddenException,
    );
  });

  it('round-trips: a key it builds is a key it accepts', () => {
    const key = buildGraphThreadId('tenant-a', 'thr1', 'msg1');
    expect(() => assertOwnsGraphThread('tenant-a', key)).not.toThrow();
  });
});
