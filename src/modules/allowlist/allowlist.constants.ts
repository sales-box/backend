/** BullMQ queue that delivers Sales-Engineer invite emails. */
export const SE_INVITE_QUEUE = 'se-invites';
export const SEND_SE_INVITE_JOB = 'send-se-invite';
export const SEND_SE_REVOKED_JOB = 'send-se-revoked';

export interface SendSeInviteJobData {
  email: string;
  companyName: string;
}

export interface SendSeRevokedJobData {
  email: string;
  companyName: string;
}

/** Both mail jobs ride the same queue; the job NAME selects the template. */
export type SeMailJobData = SendSeInviteJobData | SendSeRevokedJobData;

/** What actually happened to the row, so the UI can say something true. */
export type RevokeOutcome = 'revoked' | 'already_revoked' | 'not_found';

/**
 * The three states an allowlist entry moves through. Shared with the service so
 * the bulk path and the single-grant path cannot drift apart on the strings.
 */
export const GRANTED = 'granted';
export const VERIFIED = 'verified';
export const REVOKED = 'revoked';
/** ConnectedAccount's healthy state — what revoking flips away from. */
export const CONNECTED = 'connected';

/** How many Sales Engineers each plan tier may have active at once. */
export const TIER_SE_LIMITS: Record<number, number> = { 1: 3, 2: 10, 3: 50 };
export const DEFAULT_SE_LIMIT = 3;

/**
 * Upper bound on one bulk request. Guards the transaction (which holds an
 * advisory lock on the tenant) from being held open by a pathological paste,
 * and bounds how many invite jobs a single click can enqueue.
 */
export const MAX_BULK_EMAILS = 200;

/**
 * Deliberately stricter than the RFC: no quoted local parts, no bare IP domains,
 * requires a dotted TLD. A bulk paste is machine-generated far more often than
 * hand-typed, so the common failure is a stray token that merely looks like an
 * address ("see,me@ or ask"), not a legitimately exotic mailbox.
 *
 * The ':' exclusion is not cosmetic. RFC 5322 gives "name: addr;" the meaning of
 * an address GROUP, and nodemailer honours it — so 'colon:test@x.test' was
 * stored on the allowlist verbatim while the invite was actually delivered to
 * 'test@x.test', a different mailbox entirely, and one not on the allowlist.
 * A colon can never appear in an unquoted local part, so rejecting it costs
 * nothing and closes that mis-delivery.
 */
export const EMAIL_RE = /^[^\s@,;:<>]+@[^\s@,;:<>]+\.[a-z]{2,}$/i;

/**
 * RFC 5321 caps a forward path at 254 characters. Without this an admin could
 * store — and the mailer would try to deliver to — an address of any length.
 */
export const MAX_EMAIL_LENGTH = 254;

/** What happened to one address in a bulk request. */
export type BulkGrantOutcome =
  'added' | 'reactivated' | 'duplicate' | 'invalid' | 'over_limit';

export interface BulkGrantRow {
  email: string;
  outcome: BulkGrantOutcome;
}

export interface BulkGrantResult {
  results: BulkGrantRow[];
  summary: Record<BulkGrantOutcome, number>;
  seats: { used: number; limit: number };
}
