/** Hard limits + fixed values for the external content resolver (US-043). */

// Abort any Drive fetch or S3 put that exceeds this wall-clock time.
export const EXTERNAL_CONTENT_TIMEOUT_MS = 30_000;

// Largest file we will download/store. Streaming is aborted the instant the
// running total exceeds this — the whole file is never buffered.
export const MAX_EXTERNAL_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

// Per-email DoS cap: never process more than this many URLs from one body.
export const MAX_URLS_PER_EMAIL = 10;

// Never scan more than this many bytes of a body when finding URLs — bounds
// CPU/memory on a hostile multi-megabyte payload.
export const MAX_SCAN_BYTES = 512 * 1024; // 512 KB

// Reject absurdly long Drive file ids before any API call.
export const MAX_FILE_ID_LEN = 128;

// Bound concurrent Drive + S3 work per resolve() call.
export const GLOBAL_FETCH_CONCURRENCY = 3;

// Read-only Drive scope — the only scope the admin connection needs.
export const DRIVE_READONLY_SCOPE =
  'https://www.googleapis.com/auth/drive.readonly';

// Exact hosts routed to the Drive resolver. Membership is checked by exact
// equality only — never substring/suffix — after the allow-list gate passes.
export const GOOGLE_DRIVE_HOSTS: ReadonlySet<string> = new Set([
  'drive.google.com',
  'docs.google.com',
]);

// Google-native docs (Docs/Sheets/Slides) have no direct media and must be
// downloaded via files.export instead of files.get({alt:'media'}).
export const GOOGLE_NATIVE_MIME_PREFIX = 'application/vnd.google-apps.';
