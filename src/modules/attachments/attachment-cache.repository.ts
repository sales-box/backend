import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import type { ParsedAttachment } from './attachments.service';

/** Parsed attachments are immutable per attachmentId, so 24h is safe. */
export const ATTACHMENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY_PREFIX = 'attachments:parsed:';

/**
 * Redis-backed cache for parsed attachments (global CACHE_MANAGER from
 * app.module). Keyed by Gmail attachmentId. Fails soft: a cache outage
 * degrades to a re-parse, it never crashes the pipeline.
 */
@Injectable()
export class AttachmentCacheRepository {
  private readonly logger = new Logger(AttachmentCacheRepository.name);

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  private keyFor(attachmentId: string): string {
    return `${CACHE_KEY_PREFIX}${attachmentId}`;
  }

  async get(attachmentId: string): Promise<ParsedAttachment | null> {
    try {
      const cached = await this.cache.get<ParsedAttachment>(
        this.keyFor(attachmentId),
      );
      return cached ?? null;
    } catch (err) {
      this.logger.warn(
        `Cache read failed for attachment ${attachmentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async set(attachmentId: string, parsed: ParsedAttachment): Promise<void> {
    try {
      await this.cache.set(
        this.keyFor(attachmentId),
        parsed,
        ATTACHMENT_CACHE_TTL_MS,
      );
    } catch (err) {
      this.logger.warn(
        `Cache write failed for attachment ${attachmentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
