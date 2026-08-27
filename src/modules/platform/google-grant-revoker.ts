import { Injectable, Logger } from '@nestjs/common';
import { CryptoService } from '../auth/crypto.service';

/** A mailbox we may still hold a live Google grant for. */
export interface RevocableAccount {
  email: string;
  refreshToken: string | null;
}

/**
 * Best-effort revocation of a mailbox's Google grant.
 *
 * Deleting our copy of a refresh token does not invalidate it — the grant stays
 * live in the customer's Google account, and once the row is gone we no longer
 * know which grant to revoke. So revocation has to happen BEFORE the delete,
 * and it has to be best-effort: a mailbox that cannot be removed because Google
 * is briefly unreachable would be worse than a grant that needs manual cleanup.
 *
 * Shared by tenant purge and single-member removal so the two paths cannot
 * drift — a copy that forgets to revoke leaks access silently.
 */
@Injectable()
export class GoogleGrantRevoker {
  private readonly logger = new Logger(GoogleGrantRevoker.name);

  constructor(private readonly crypto: CryptoService) {}

  /**
   * @param context - Human-readable subject for the log line (e.g. a tenant
   *   id). Never the mailbox address: these logs outlive the account.
   */
  async revokeAll(
    accounts: readonly RevocableAccount[],
    context: string,
  ): Promise<void> {
    for (const account of accounts) {
      if (!account.refreshToken) continue;
      try {
        const token = this.crypto.decrypt(account.refreshToken);
        const res = await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
        });
        if (!res.ok) {
          this.logger.error(
            `Google revoke returned ${res.status} for a mailbox of ${context}; the grant may still be live`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Google revoke failed for a mailbox of ${context}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
