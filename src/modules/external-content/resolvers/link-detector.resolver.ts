import { Injectable } from '@nestjs/common';
import { isIP } from 'node:net';
import { PrismaService } from '../../../database/prisma.service';
import {
  GOOGLE_DRIVE_HOSTS,
  MAX_SCAN_BYTES,
  MAX_URLS_PER_EMAIL,
} from '../external-content.constants';
import { ExternalContentSourceType } from '../external-content.types';

export interface DetectedLink {
  originalRef: string;
  domain: string;
  classification: ExternalContentSourceType;
  /** True only when the host is present in the DB allow-list (SSRF gate). */
  allowed: boolean;
  /** True when the URL was unparseable / unsafe and must never be fetched. */
  parseFailed: boolean;
}

// Finder only — WHATWG URL is the sole authority on the host. Stops at
// whitespace and the common delimiters that wrap URLs in text/HTML.
const URL_FINDER = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

@Injectable()
export class LinkDetectorResolver {
  constructor(private readonly prisma: PrismaService) {}

  async detect(emailBody: string): Promise<DetectedLink[]> {
    const results: DetectedLink[] = [];

    for (const raw of this.extractCandidates(emailBody)) {
      const host = this.safeHostname(raw);

      // Unparseable / unsafe → never touch the DB or a fetcher.
      if (host === null) {
        results.push({
          originalRef: raw,
          domain: '',
          classification: 'unknown_link',
          allowed: false,
          parseFailed: true,
        });
        continue;
      }

      // Exact-equality allow-list lookup — the SSRF gate. Never substring.
      const row = await this.prisma.allowedDomain.findUnique({
        where: { domain: host },
        select: { id: true },
      });

      results.push({
        originalRef: raw,
        domain: host,
        classification: GOOGLE_DRIVE_HOSTS.has(host)
          ? 'google_drive'
          : 'unknown_link',
        allowed: row !== null,
        parseFailed: false,
      });
    }

    return results;
  }

  private extractCandidates(body: string): string[] {
    if (typeof body !== 'string' || body.length === 0) return [];

    // Bound the scan, then stop the instant we have the cap — never materialise
    // a match array for the whole (possibly hostile) body.
    const scanned =
      body.length > MAX_SCAN_BYTES ? body.slice(0, MAX_SCAN_BYTES) : body;
    const finder = new RegExp(URL_FINDER.source, 'gi');
    const seen = new Set<string>();
    const out: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = finder.exec(scanned)) !== null) {
      // Decode the common HTML entity that otherwise corrupts query strings.
      const url = match[0].replace(/&amp;/gi, '&');
      if (!seen.has(url)) {
        seen.add(url);
        out.push(url);
        if (out.length >= MAX_URLS_PER_EMAIL) break; // per-email DoS cap
      }
      if (match.index === finder.lastIndex) finder.lastIndex++;
    }

    return out;
  }

  /**
   * Returns the exact lowercased host if the URL is a safe https web address,
   * or null for anything that must never be fetched. WHATWG URL is the sole
   * authority — the finder regex never decides the host.
   */
  private safeHostname(raw: string): string | null {
    // Validate the RAW authority is pure ASCII [a-z0-9.-] BEFORE WHATWG runs.
    // This is what stops IDNA/UTS-46/percent-encoding from collapsing a spoofed
    // host — ｄｒｉｖｅ.google.com, %64rive.google.com, unicode dots (。．), soft
    // hyphen, zero-width chars — into a real allow-listed host. Running the
    // ASCII check on url.hostname (post-normalization) would miss all of these.
    const authMatch = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw);
    if (authMatch === null) return null;
    let authority = authMatch[1];
    const at = authority.lastIndexOf('@');
    if (at !== -1) authority = authority.slice(at + 1); // drop userinfo
    if (!authority.includes('[')) {
      const colon = authority.lastIndexOf(':');
      if (colon !== -1) authority = authority.slice(0, colon); // drop port
    }
    if (!/^[a-zA-Z0-9.-]+$/.test(authority)) return null;

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null; // unparseable
    }

    if (url.protocol !== 'https:') return null; // https only
    if (url.username !== '' || url.password !== '') return null; // userinfo trick

    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host.length === 0 || host.length > 253) return null;

    // Reject single-label hosts: localhost, decimal/hex IPs (0x7f000001,
    // 2130706433), internal names. Every legitimate public domain has a dot.
    if (!host.includes('.')) return null;

    // Reject IP literals (v4 + v6). Strip IPv6 brackets first — net.isIP does
    // not recognise the bracketed form on its own.
    const bare =
      host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    if (isIP(bare) !== 0) return null;

    // Reject non-ASCII residue. Punycode (xn--) stays ASCII but will simply
    // fail the exact allow-list match; raw Unicode/homographs die here.
    if (/[^a-z0-9.-]/.test(host)) return null;

    return host;
  }
}
