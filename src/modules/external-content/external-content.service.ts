import { Injectable, Logger } from '@nestjs/common';
import { GLOBAL_FETCH_CONCURRENCY } from './external-content.constants';
import { ResolvedExternalContent, extFromMime } from './external-content.types';
import { errName, mapWithConcurrency } from './external-content.util';
import { GoogleDriveResolver } from './resolvers/google-drive.resolver';
import {
  DetectedLink,
  LinkDetectorResolver,
} from './resolvers/link-detector.resolver';
import { ExternalContentStorageService } from './storage/external-content-storage.service';

type AdminAuth = Awaited<ReturnType<GoogleDriveResolver['getAdminAuth']>>;

/**
 * Orchestrator ("traffic cop") for US-043. Detects links in an email body,
 * gates them on the allow-list, fetches Drive files via the single admin
 * connection, stores raw bytes, and returns one ResolvedExternalContent per
 * link. Never throws — each link is isolated in its own try/catch.
 */
@Injectable()
export class ExternalContentService {
  private readonly logger = new Logger(ExternalContentService.name);

  constructor(
    private readonly detector: LinkDetectorResolver,
    private readonly drive: GoogleDriveResolver,
    private readonly storage: ExternalContentStorageService,
  ) {}

  async resolveExternalContent(
    emailBody: string,
    interactionId: string,
  ): Promise<ResolvedExternalContent[]> {
    const links = await this.detector.detect(emailBody);

    // Admin creds fetched ONCE per call. If unavailable it is a systemic
    // failure (one log), and every Drive link short-circuits to fetch_failed —
    // never N per-link warnings hiding an outage.
    let auth: AdminAuth = null;
    const needsDrive = links.some(
      (link) => link.allowed && link.classification === 'google_drive',
    );
    if (needsDrive) {
      auth = await this.drive.getAdminAuth();
      if (auth === null) {
        this.logger.error(
          'Admin Drive connection unavailable — all Drive links this batch resolve to fetch_failed',
        );
      }
    }

    return mapWithConcurrency(links, GLOBAL_FETCH_CONCURRENCY, (link) =>
      this.resolveLink(link, interactionId, auth),
    );
  }

  private async resolveLink(
    link: DetectedLink,
    interactionId: string,
    auth: AdminAuth,
  ): Promise<ResolvedExternalContent> {
    const base: ResolvedExternalContent = {
      sourceType: link.classification,
      originalRef: link.originalRef,
      domain: link.domain,
      fetched: false,
      summary: undefined,
      skipped: true,
    };

    try {
      if (!link.allowed) {
        return {
          ...base,
          reason: link.parseFailed ? 'parse_error' : 'unrecognized_domain',
        };
      }
      if (link.classification !== 'google_drive') {
        return { ...base, reason: 'not_attempted' };
      }
      if (auth === null) {
        return { ...base, reason: 'fetch_failed' }; // systemic outage, logged once
      }

      const url = new URL(link.originalRef);
      // A Drive URL that isn't a single fetchable file (e.g. a /folders/ link)
      // has no file id → permanent parse_error, never attempt a fetch.
      const fileId = this.drive.extractFileId(url);
      if (fileId === null) {
        return { ...base, reason: 'parse_error' };
      }

      const raw = await this.drive.fetchRaw(url, auth);
      if (raw === null) {
        return { ...base, reason: 'fetch_failed' };
      }

      // fetched:true is locked in before storage; a store failure never resets
      // it — a distinct (rawStorageKey:undefined + fetch_failed) signals it.
      const fetched: ResolvedExternalContent = {
        ...base,
        fetched: true,
        skipped: false,
      };
      const key = this.storage.buildObjectKey(
        interactionId,
        fileId,
        raw.bytes,
        extFromMime(raw.contentType),
      );
      const stored = await this.storage.store(raw.bytes, key, raw.contentType);
      return stored === undefined
        ? { ...fetched, rawStorageKey: undefined, reason: 'fetch_failed' }
        : { ...fetched, rawStorageKey: stored };
    } catch (err) {
      // Never propagate — one bad link must not break the others. Host + name
      // only, never the raw URL or error message.
      this.logger.error(`Link failed host=${link.domain} err=${errName(err)}`);
      return { ...base, reason: 'fetch_failed' };
    }
  }
}
