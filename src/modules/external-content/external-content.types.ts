export type ExternalContentSourceType = 'google_drive' | 'unknown_link';

export type ExternalContentReason =
  'unrecognized_domain' | 'fetch_failed' | 'parse_error' | 'not_attempted';

/**
 * Universal envelope returned for every URL found in an email body. Consumers
 * read this without caring whether the content came from Google Drive or an
 * unrecognized link. `summary` is ALWAYS undefined this sprint (no AI).
 */
export interface ResolvedExternalContent {
  sourceType: ExternalContentSourceType;
  originalRef: string;
  domain: string;
  fetched: boolean;
  rawStorageKey?: string;
  summary?: undefined;
  skipped: boolean;
  reason?: ExternalContentReason;
  /** Human-readable explanation for the client (e.g. why a link was skipped). */
  detail?: string;
}

const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/zip': 'zip',
};

/**
 * Total function — never throws. Maps a MIME type to a safe file extension,
 * falling back to 'bin' for unknown/undefined types.
 */
export function extFromMime(mime: string | undefined): string {
  if (typeof mime !== 'string') return 'bin';
  return MIME_EXT[mime.split(';')[0].trim().toLowerCase()] ?? 'bin';
}
