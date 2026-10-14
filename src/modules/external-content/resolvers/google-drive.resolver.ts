import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { Readable } from 'node:stream';
import { PrismaService } from '../../../database/prisma.service';
import { CryptoService } from '../../auth/crypto.service';
import {
  EXTERNAL_CONTENT_TIMEOUT_MS,
  GOOGLE_NATIVE_MIME_PREFIX,
  MAX_EXTERNAL_FILE_BYTES,
  MAX_FILE_ID_LEN,
} from '../external-content.constants';
import { errName } from '../external-content.util';

export interface FetchedFile {
  bytes: Buffer;
  contentType: string;
}

// Google file ids in the URL forms we accept.
const FILE_ID_PATH =
  /\/(?:file|document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]+)/;
const FILE_ID_SHAPE = new RegExp(`^[A-Za-z0-9_-]{10,${MAX_FILE_ID_LEN}}$`);

@Injectable()
export class GoogleDriveResolver {
  private readonly logger = new Logger(GoogleDriveResolver.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** Extracts a Drive file id from the URL, or null if none/invalid. */
  extractFileId(url: URL): string | null {
    const fromPath = FILE_ID_PATH.exec(url.pathname)?.[1];
    const id = fromPath ?? url.searchParams.get('id');
    return id !== null && id !== undefined && FILE_ID_SHAPE.test(id)
      ? id
      : null;
  }

  /**
   * Downloads the raw bytes for a Drive URL using the single admin connection.
   * Returns null (never throws) for a bad id, a missing/expired/revoked admin
   * token, an over-cap file, a timeout, or any API error.
   */
  async fetchRaw(
    url: URL,
    auth: InstanceType<typeof google.auth.OAuth2>,
  ): Promise<FetchedFile | null> {
    const fileId = this.extractFileId(url);
    if (fileId === null) return null;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      EXTERNAL_CONTENT_TIMEOUT_MS,
    );
    try {
      const drive = google.drive({ version: 'v3', auth });

      // Never trust a client-declared size; ask Drive for the real mime type.
      const meta = await drive.files.get(
        { fileId, fields: 'id,mimeType', supportsAllDrives: true },
        { signal: controller.signal },
      );
      const mimeType = meta.data.mimeType ?? 'application/octet-stream';
      const isNative = mimeType.startsWith(GOOGLE_NATIVE_MIME_PREFIX);
      // Native Docs/Sheets/Slides have no direct media — export them as PDF.
      const contentType = isNative ? 'application/pdf' : mimeType;

      const res = isNative
        ? await drive.files.export(
            { fileId, mimeType: contentType },
            { responseType: 'stream', signal: controller.signal },
          )
        : await drive.files.get(
            { fileId, alt: 'media', supportsAllDrives: true },
            { responseType: 'stream', signal: controller.signal },
          );

      const bytes = await this.readCapped(res.data, controller);
      return bytes === null ? null : { bytes, contentType };
    } catch (err) {
      // invalid_grant / 401 / 403 / 404 / timeout all land here. Name/code only.
      this.logger.warn(
        `Drive fetch failed fileId=${fileId} err=${errName(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Builds the tenant's OAuth2 client once per resolve, or null if unusable.
   * Tenant-scoped: a tenant only ever gets ITS OWN DriveConnection — never
   * another tenant's and never a silent fallback to the shared legacy row.
   * Callers without a tenant (legacy) match only the pre-tenant row
   * (tenantId NULL).
   */
  async getAdminAuth(
    tenantId?: string,
  ): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
    const conn = await this.prisma.driveConnection.findFirst({
      where: { status: 'connected', tenantId: tenantId ?? null },
      orderBy: { createdAt: 'asc' },
    });
    if (conn === null) {
      this.logger.warn(
        `No Drive connection configured for this tenant (tenant=${tenantId ?? 'none'})`,
      );
      return null;
    }

    let accessToken: string;
    let refreshToken: string | undefined;
    try {
      accessToken = this.crypto.decrypt(conn.accessToken);
      refreshToken = conn.refreshToken
        ? this.crypto.decrypt(conn.refreshToken)
        : undefined;
    } catch (err) {
      this.logger.warn(`Admin Drive token decrypt failed err=${errName(err)}`);
      return null;
    }

    const oauth2 = new google.auth.OAuth2(
      this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      this.config.getOrThrow<string>('GOOGLE_REDIRECT_URI'),
    );
    // google-auth-library refreshes the access token from refresh_token on
    // demand; if the refresh fails (revoked) the API call throws → caught → null.
    oauth2.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
      expiry_date: conn.tokenExpiresAt
        ? conn.tokenExpiresAt.getTime()
        : undefined,
    });
    return oauth2;
  }

  /**
   * Reads a stream into a Buffer, aborting the instant the running total would
   * exceed the cap — the whole file is never buffered. Never rejects.
   */
  private readCapped(
    stream: Readable,
    controller: AbortController,
  ): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const finish = (value: Buffer | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_EXTERNAL_FILE_BYTES) {
          controller.abort();
          stream.destroy();
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      stream.once('end', () => finish(Buffer.concat(chunks)));
      stream.once('error', () => finish(null));
      stream.once('close', () => finish(null));
    });
  }
}
