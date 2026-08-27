import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { EMAIL_RE } from '../allowlist/allowlist.constants';
import { GoogleGrantRevoker } from './google-grant-revoker';

/** One person's presence in a workspace, as the operator console shows it. */
export interface TenantMember {
  email: string;
  /** The workspace admin is the account that owns the password login. */
  role: 'admin' | 'se';
  /** granted | verified | revoked, or null when there is no seat at all. */
  seatStatus: string | null;
  /** connected | revoked, or null when the mailbox was never connected. */
  accountStatus: string | null;
  /** Has this person actually connected a mailbox (vs. only been invited). */
  connected: boolean;
  addedAt: Date | null;
  lastLoginAt: Date | null;
}

export interface RemoveMemberResult {
  email: string;
  removedSeat: boolean;
  removedAccount: boolean;
  wasAdmin: boolean;
}

/**
 * Operator-side roster management: who is in a workspace, and removing them
 * outright.
 *
 * Distinct from AllowlistService, which is the TENANT admin's view — that one
 * revokes (keeps the row, keeps the address taken) and is scoped to the caller's
 * own tenant. This one is the platform escape hatch: it removes across any
 * tenant and frees the address for re-use. Both are needed; neither replaces
 * the other.
 */
@Injectable()
export class PlatformMembersService {
  private readonly logger = new Logger(PlatformMembersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly revoker: GoogleGrantRevoker,
  ) {}

  /**
   * Everyone attached to a workspace, seats and mailboxes merged.
   *
   * The two tables drift apart legitimately — an invited engineer has a seat
   * and no mailbox, and a mailbox can outlive its seat after a revoke — so the
   * roster is a union, not a join. Showing only one side would hide exactly the
   * rows an operator is called in to clean up.
   */
  async list(tenantId: string): Promise<TenantMember[]> {
    await this.assertTenantExists(tenantId);

    const [entries, accounts] = await Promise.all([
      this.prisma.allowlistEntry.findMany({
        where: { tenantId },
        select: { email: true, status: true, grantedAt: true },
      }),
      this.prisma.connectedAccount.findMany({
        where: { tenantId },
        select: {
          email: true,
          status: true,
          isAdmin: true,
          createdAt: true,
          lastLoginAt: true,
        },
      }),
    ]);

    // Keyed by lowercased address: the two tables were written by different
    // code paths and a legacy row may differ only in case. Keying on the raw
    // string would list one person twice.
    const members = new Map<string, TenantMember>();
    const upsert = (email: string): TenantMember => {
      const key = email.toLowerCase();
      let member = members.get(key);
      if (!member) {
        member = {
          email: key,
          role: 'se',
          seatStatus: null,
          accountStatus: null,
          connected: false,
          addedAt: null,
          lastLoginAt: null,
        };
        members.set(key, member);
      }
      return member;
    };

    for (const entry of entries) {
      const member = upsert(entry.email);
      member.seatStatus = entry.status;
      member.addedAt = entry.grantedAt;
    }
    for (const account of accounts) {
      const member = upsert(account.email);
      member.accountStatus = account.status;
      member.connected = true;
      member.lastLoginAt = account.lastLoginAt;
      if (account.isAdmin) member.role = 'admin';
      // Only when there is no seat — a seat's grantedAt is when they were
      // given access, which is the date the operator cares about.
      member.addedAt ??= account.createdAt;
    }

    return [...members.values()].sort((a, b) => {
      // Admins first, then by address, so the roster reads the same every load.
      if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
      return a.email.localeCompare(b.email);
    });
  }

  /**
   * Removes one person from one workspace, permanently.
   *
   * Deletes the seat and the mailbox row, which frees the address: the uniqueness
   * that blocks re-adding someone is `(tenantId, email)` on both tables, so
   * revoking alone leaves the address taken by this tenant forever. That lockout
   * is the reason this exists.
   *
   * Deliberately kept:
   *  - `general_analysis` / `escalation_items` / `interactions` — these belong to
   *    the WORKSPACE, not the person. Removing an engineer must not rewrite the
   *    company's analytics history.
   *  - `processed_gmail_messages` — the de-duplication ledger. `general_analysis.
   *    message_id` is globally unique, so dropping the ledger while keeping the
   *    analyses would make a re-connected mailbox re-process the same messages
   *    and collide on insert.
   *
   * The mailbox's `webhook_subscriptions` row goes with it via ON DELETE CASCADE.
   */
  async remove(
    tenantId: string,
    rawEmail: string,
  ): Promise<RemoveMemberResult> {
    const email = rawEmail.toLowerCase().trim();
    if (!EMAIL_RE.test(email)) {
      throw new BadRequestException(`'${rawEmail}' is not an email address`);
    }
    await this.assertTenantExists(tenantId);

    // Case-insensitive on both sides, for the same reason `list` lowercases:
    // an exact match silently removes nothing and reports success.
    const match = { equals: email, mode: 'insensitive' as const };
    const [entry, account] = await Promise.all([
      this.prisma.allowlistEntry.findFirst({
        where: { tenantId, email: match },
        select: { id: true },
      }),
      this.prisma.connectedAccount.findFirst({
        where: { tenantId, email: match },
        select: { id: true, isAdmin: true, refreshToken: true, email: true },
      }),
    ]);

    if (!entry && !account) {
      throw new NotFoundException(
        `${email} is not a member of this workspace.`,
      );
    }

    // Before the delete — afterwards we no longer hold the token to revoke.
    if (account) {
      await this.revoker.revokeAll([account], `tenant ${tenantId}`);
    }

    await this.prisma.$transaction([
      ...(entry
        ? [this.prisma.allowlistEntry.delete({ where: { id: entry.id } })]
        : []),
      ...(account
        ? [this.prisma.connectedAccount.delete({ where: { id: account.id } })]
        : []),
    ]);

    this.logger.warn(
      `Operator removed a member of tenant ${tenantId} (seat: ${!!entry}, mailbox: ${!!account}, admin: ${!!account?.isAdmin})`,
    );

    return {
      email,
      removedSeat: !!entry,
      removedAccount: !!account,
      wasAdmin: !!account?.isAdmin,
    };
  }

  private async assertTenantExists(tenantId: string): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
  }
}
