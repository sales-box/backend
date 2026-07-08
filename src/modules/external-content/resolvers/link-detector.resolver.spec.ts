import type { PrismaService } from '../../../database/prisma.service';
import { LinkDetectorResolver } from './link-detector.resolver';

describe('LinkDetectorResolver', () => {
  const ALLOWED = new Set(['drive.google.com', 'docs.google.com']);
  let findUnique: jest.Mock;
  let resolver: LinkDetectorResolver;

  beforeEach(() => {
    findUnique = jest
      .fn()
      .mockImplementation(({ where }: { where: { domain: string } }) =>
        Promise.resolve(ALLOWED.has(where.domain) ? { id: 'x' } : null),
      );
    const prisma = {
      allowedDomain: { findUnique },
    } as unknown as PrismaService;
    resolver = new LinkDetectorResolver(prisma);
  });

  const one = async (body: string) => (await resolver.detect(body))[0];

  it('classifies an allow-listed Drive link as google_drive + allowed', async () => {
    const r = await one(
      'see https://drive.google.com/file/d/ABC123DEF456/view',
    );
    expect(r).toMatchObject({
      domain: 'drive.google.com',
      classification: 'google_drive',
      allowed: true,
      parseFailed: false,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { domain: 'drive.google.com' },
      select: { id: true },
    });
  });

  it('treats an unlisted domain as unknown_link + not allowed (S2-V7 feed)', async () => {
    const r = await one('click https://evil.com/pwn');
    expect(r).toMatchObject({
      domain: 'evil.com',
      classification: 'unknown_link',
      allowed: false,
    });
  });

  // ---- SSRF bypass matrix: each must NOT be allowed, and the dangerous forms
  // must never even reach the DB (findUnique not called). ----

  it('rejects suffix-confusion drive.google.com.evil.com (exact match only)', async () => {
    const r = await one('https://drive.google.com.evil.com/x');
    expect(r.allowed).toBe(false);
    expect(r.classification).toBe('unknown_link');
    expect(findUnique).toHaveBeenCalledWith({
      where: { domain: 'drive.google.com.evil.com' },
      select: { id: true },
    });
  });

  it('rejects prefix-confusion evildrive.google.com', async () => {
    const r = await one('https://evildrive.google.com/x');
    expect(r.allowed).toBe(false);
  });

  it.each([
    ['userinfo @evil.com', 'https://drive.google.com@evil.com/x'],
    ['http (non-https)', 'http://drive.google.com/x'],
    ['ipv4 literal', 'https://93.184.216.34/x'],
    ['ipv6 bracket ::1', 'https://[::1]/x'],
    ['ipv6 bracket fe80', 'https://[fe80::1]/x'],
    ['ipv4-mapped ipv6', 'https://[::ffff:169.254.169.254]/x'],
    ['localhost', 'https://localhost/x'],
    ['decimal ip', 'https://2130706433/x'],
    ['hex ip', 'https://0x7f000001/x'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data'],
    ['unterminated ipv6', 'https://[bad'],
    ['single-label host', 'https://intranet/x'],
  ])('never fetches + never hits DB: %s', async (_label, url) => {
    const r = await one(url);
    expect(r.allowed).toBe(false);
    expect(r.classification).toBe('unknown_link');
    expect(r.parseFailed).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('ignores non-http(s) schemes entirely (ftp/mailto/htp not detected)', async () => {
    const links = await resolver.detect(
      'ftp://drive.google.com/x mailto:a@b.com htp:/broken',
    );
    expect(links).toEqual([]);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('lowercases the host before the exact lookup', async () => {
    const r = await one('https://DRIVE.GOOGLE.COM/file/d/ABC123DEF456/view');
    expect(r.domain).toBe('drive.google.com');
    expect(r.allowed).toBe(true);
  });

  it('strips a trailing-dot FQDN', async () => {
    const r = await one('https://drive.google.com./x');
    expect(r.domain).toBe('drive.google.com');
    expect(r.allowed).toBe(true);
  });

  it('rejects a raw-unicode homograph host', async () => {
    // "аpple" with a Cyrillic а — WHATWG punycodes it; never matches allow-list.
    const r = await one('https://exаmple.com/x');
    expect(r.allowed).toBe(false);
  });

  it.each([
    ['fullwidth latin', 'https://ｄｒｉｖｅ.google.com/x'],
    ['percent-encoded d', 'https://%64rive.google.com/x'],
    ['ideographic dot', 'https://drive.google.com。evil.com/x'],
    ['fullwidth dot', 'https://drive.google.com．evil.com/x'],
    ['soft hyphen', 'https://drive.google.com­/x'],
    ['zero-width', 'https://drive.google.com​.evil.com/x'],
  ])(
    'rejects UTS-46/normalization spoof via raw-authority gate: %s',
    async (_label, url) => {
      const r = await one(url);
      expect(r.allowed).toBe(false);
      expect(r.classification).toBe('unknown_link');
      expect(r.parseFailed).toBe(true);
      expect(findUnique).not.toHaveBeenCalled();
    },
  );

  it('stops after MAX_URLS without scanning the whole body (early break)', async () => {
    const body = Array.from(
      { length: 5000 },
      (_v, i) => `https://evil.com/p${i}`,
    ).join(' ');
    const links = await resolver.detect(body);
    expect(links).toHaveLength(10);
    expect(findUnique.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('decodes &amp; in the query string so the URL is not corrupted', async () => {
    const r = await one(
      'https://drive.google.com/open?id=ABC123DEF456&amp;usp=sharing',
    );
    expect(r.originalRef).toContain('&usp=sharing');
    expect(r.originalRef).not.toContain('&amp;');
    expect(r.allowed).toBe(true);
  });

  it('dedupes repeated URLs', async () => {
    const links = await resolver.detect(
      'https://evil.com/a and again https://evil.com/a',
    );
    expect(links).toHaveLength(1);
  });

  it('caps at MAX_URLS_PER_EMAIL (10)', async () => {
    const body = Array.from(
      { length: 15 },
      (_v, i) => `https://evil.com/p${i}`,
    ).join(' ');
    const links = await resolver.detect(body);
    expect(links).toHaveLength(10);
  });

  it('returns [] for an empty body', async () => {
    expect(await resolver.detect('')).toEqual([]);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('handles a 3-link mixed body (ok / unlisted / malformed)', async () => {
    const links = await resolver.detect(
      'https://drive.google.com/file/d/ABC123DEF456/view ' +
        'https://unknown.io/a ' +
        'https://[bad',
    );
    expect(links).toHaveLength(3);
    expect(links[0]).toMatchObject({
      classification: 'google_drive',
      allowed: true,
    });
    expect(links[1]).toMatchObject({
      classification: 'unknown_link',
      allowed: false,
      parseFailed: false,
    });
    expect(links[2]).toMatchObject({ parseFailed: true, allowed: false });
  });
});
