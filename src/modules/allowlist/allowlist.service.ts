import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '@/database/prisma.service';
import { EmailNotifyService } from '../email-notify/email-notify.service';
import {
  BulkGrantOutcome,
  BulkGrantResult,
  BulkGrantRow,
  DEFAULT_SE_LIMIT,
  EMAIL_RE,
  MAX_EMAIL_LENGTH,
  GRANTED,
  REVOKED,
  CONNECTED,
  RevokeOutcome,
  SEND_SE_INVITE_JOB,
  SEND_SE_REVOKED_JOB,
  SE_INVITE_QUEUE,
  SendSeInviteJobData,
  TIER_SE_LIMITS,
  VERIFIED,
} from './allowlist.constants';

@Injectable()
export class AllowlistService {
  private readonly logger = new Logger(AllowlistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailNotifyService,
    @InjectQueue(SE_INVITE_QUEUE)
    private readonly inviteQueue: Queue<SendSeInviteJobData>,
  ) {}

  /**
   * Hands one invite to the queue. Never throws: a Redis hiccup must not undo a
   * grant that is already committed. If enqueueing fails we fall back to sending
   * inline so the SE still hears from us, and that path swallows its own errors.
   */
  private async enqueueInvite(
    email: string,
    companyName: string,
  ): Promise<void> {
    try {
      await this.inviteQueue.add(
        SEND_SE_INVITE_JOB,
        { email, companyName },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
    } catch (err) {
      this.logger.error(
        `Could not queue SE invite for ${email}, sending inline: ${String(err)}`,
      );
      await this.email.sendSeInvite(email, companyName);
    }
  }

  /**
   * Admin adds an SE to the tenant's allowlist. Rejects if the tenant is already
   * at its plan tier's SE cap, then records the entry as granted and emails the
   * SE the extension install link.
   *
   * Accepts an optional Prisma transaction client so it can run atomically inside
   * another operation (e.g. tenant activation grants the admin's own email).
   *
   * @param skipInvite - When true, suppresses the SE-branded invite email.
   *   Pass true during tenant activation so the admin does not receive
   *   "install the extension" copy meant for Sales Engineers.
   *   Defaults to false; existing call sites need no change.
   */
  async grantAccess(
    tenantId: string,
    rawEmail: string,
    tx?: Prisma.TransactionClient,
    skipInvite = false,
  ): Promise<{ outcome: 'added' | 'reactivated' | 'duplicate' }> {
    const email = rawEmail.toLowerCase().trim();
    const db = tx ?? this.prisma;

    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    // Is this person already on the team? Matched case-insensitively, because
    // the unique index is on the exact string and a legacy row stored with
    // capitals would otherwise miss and be inserted a second time.
    const existing = await db.allowlistEntry.findFirst({
      where: { tenantId, email: { equals: email, mode: 'insensitive' } },
      select: { id: true, status: true },
    });

    if (existing?.status === GRANTED || existing?.status === VERIFIED) {
      // Already active. Do NOT rewrite the row and do NOT send another invite.
      //
      // The unconditional upsert that used to live here demoted a VERIFIED
      // engineer back to granted, reset grantedAt to today (so the team page's
      // "Date added" jumped forward), and mailed them a second "install the
      // extension" invite — while the UI still displayed them as Verified,
      // because listAllowlist derives the shown status from the connected
      // account and so hid the demotion.
      this.logger.log(`${email} is already on tenant ${tenantId}; left as is`);
      return { outcome: 'duplicate' };
    }

    // The cap is checked only AFTER the duplicate short-circuit above. Someone
    // who is already on the team occupies their seat either way, so re-adding
    // them must never be refused for being "at the plan limit" — that message
    // sends the admin off to buy seats they do not need. Same ordering as
    // grantAccessBulk.
    const activeCount = await db.allowlistEntry.count({
      where: { tenantId, status: { in: [GRANTED, VERIFIED] } },
    });
    const limit = TIER_SE_LIMITS[tenant.tier] ?? DEFAULT_SE_LIMIT;
    if (activeCount >= limit) {
      throw new ForbiddenException(
        `Tenant is at its plan limit of ${limit} sales engineers`,
      );
    }

    if (existing) {
      // Revoked, or some legacy status this build does not recognise. A row
      // already exists for this person, so update THAT row by id.
      await db.allowlistEntry.update({
        where: { id: existing.id },
        data: { status: GRANTED, grantedAt: new Date(), revokedAt: null },
      });
    } else {
      await db.allowlistEntry.create({
        data: { tenantId, email, status: GRANTED },
      });
    }

    // Put the live account back too. revokeAccess flips BOTH the allowlist entry
    // and the ConnectedAccount, but nothing flipped the account back — so a
    // restored engineer got a green allowlist row and still could not sign in,
    // because the session heartbeat rejects a revoked account. Only rows that
    // are currently revoked are touched; a connected account is left alone.
    await db.connectedAccount.updateMany({
      where: {
        tenantId,
        email: { equals: email, mode: 'insensitive' },
        status: REVOKED,
      },
      data: { status: CONNECTED },
    });

    // Side effect after the row is written; never fails the grant.
    // skipInvite=true when called from tenant activation (admin self-grant);
    // the SE-branded "install the extension" copy is wrong in that context.
    if (!skipInvite) {
      await this.enqueueInvite(email, tenant.companyName);
    }
    this.logger.log(`Granted access to ${email} on tenant ${tenantId}`);
    return { outcome: existing ? 'reactivated' : 'added' };
  }

  /**
   * Queues the "your access has ended" notice. Never throws, for the same
   * reason enqueueInvite does not: the revocation is already committed and a
   * Redis hiccup must not make a completed revocation report as failed.
   */
  private async enqueueRevokedNotice(
    email: string,
    companyName: string,
  ): Promise<void> {
    try {
      await this.inviteQueue.add(
        SEND_SE_REVOKED_JOB,
        { email, companyName },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
    } catch (err) {
      this.logger.error(
        `Could not queue revocation notice for ${email}, sending inline: ${String(err)}`,
      );
      await this.email.sendSeRevoked(email, companyName);
    }
  }

  /**
   * Grants many addresses at once — the "paste a list / upload a CSV" path.
   *
   * Three things this does that a loop over grantAccess() would get wrong:
   *
   * 1. ALREADY-ACTIVE ADDRESSES ARE LEFT ALONE. grantAccess() upserts with
   *    `status: GRANTED` unconditionally, which on a re-paste would demote every
   *    already-verified SE back to granted and mail them all a second "install
   *    the extension" invite. Here an active entry is reported as a duplicate
   *    and not written or emailed at all, which is what "ignore duplicates"
   *    has to mean. A revoked entry is different — reactivating it is the point.
   *
   * 2. THE SEAT CAP IS CHECKED ONCE, UNDER A LOCK. grantAccess() reads the count
   *    and then writes, so two admins pasting at the same moment can both pass
   *    the check and overshoot the tier limit. The advisory lock serialises
   *    bulk grants per tenant; addresses are filled in the order given and the
   *    remainder come back as over_limit rather than failing the whole request.
   *
   * 3. EVERY ADDRESS GETS AN ANSWER. One rejected row must not discard the other
   *    forty-nine, so nothing throws on bad input — each row reports its own
   *    outcome and the admin can see exactly which lines need fixing.
   *
   * Invites are queued only after the transaction commits, so a rolled-back
   * grant can never leave someone holding a welcome email for access they
   * do not have.
   */
  async grantAccessBulk(
    tenantId: string,
    rawEmails: string[],
  ): Promise<BulkGrantResult> {
    // Pass 1 — normalise, validate, and drop repeats WITHIN the payload.
    // Order is preserved so the response lines up with what the admin pasted.
    const draft: { email: string; outcome: BulkGrantOutcome | null }[] = [];
    const pending: { email: string; idx: number }[] = [];
    const seen = new Set<string>();

    for (const raw of rawEmails) {
      const trimmed = String(raw ?? '').trim();
      const email = trimmed.toLowerCase();

      if (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
        // Echo back what they typed (capped), not the normalised form — the
        // admin needs to recognise the offending line in their own list.
        draft.push({ email: trimmed.slice(0, 320), outcome: 'invalid' });
        continue;
      }
      if (seen.has(email)) {
        draft.push({ email, outcome: 'duplicate' });
        continue;
      }
      seen.add(email);
      pending.push({ email, idx: draft.length });
      draft.push({ email, outcome: null });
    }

    // Pass 2 — decide and write, holding a per-tenant lock so the seat count
    // cannot move underneath us.
    const { toInvite, companyName, used, limit } =
      await this.prisma.$transaction(
        async (tx) => {
          const lockKey = `allowlist:${tenantId}`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

          const tenant = await tx.tenant.findUnique({
            where: { id: tenantId },
          });
          if (!tenant) {
            throw new NotFoundException('Tenant not found');
          }
          const seatLimit = TIER_SE_LIMITS[tenant.tier] ?? DEFAULT_SE_LIMIT;

          // Load the tenant's WHOLE allowlist rather than filtering by the
          // pasted addresses. Two reasons, both correctness rather than taste:
          //
          //  - A stored address may differ from the pasted one only by case.
          //    `email: { in: [...] }` compares exactly, so 'Ali@Acme.com' on
          //    file would not match a pasted 'ali@acme.com' — and because the
          //    unique index is on the exact string, the miss does not collide
          //    either: it inserts a SECOND row for the same human being, who
          //    then occupies two seats. verifyAccess (below) already matches
          //    case-insensitively, so mixed-case rows are a state this codebase
          //    expects to meet.
          //  - It also gives us the seat count from the same read, so the
          //    count and the rows can never disagree.
          //
          // The list is bounded by the seat cap plus revoked history, so this
          // is a small read, not a table scan.
          const entries = await tx.allowlistEntry.findMany({
            where: { tenantId },
            select: { id: true, email: true, status: true },
          });
          const entryByEmail = new Map(
            entries.map((e) => [e.email.toLowerCase().trim(), e]),
          );
          const byId = new Map(
            entries.map((e) => [e.id, e.email.toLowerCase().trim()]),
          );

          let activeCount = entries.filter(
            (e) => e.status === GRANTED || e.status === VERIFIED,
          ).length;

          const toCreate: string[] = [];
          const toReactivateIds: string[] = [];

          for (const p of pending) {
            const existing = entryByEmail.get(p.email);

            if (existing?.status === GRANTED || existing?.status === VERIFIED) {
              draft[p.idx].outcome = 'duplicate';
              continue;
            }
            if (activeCount >= seatLimit) {
              draft[p.idx].outcome = 'over_limit';
              continue;
            }

            activeCount++;
            if (existing) {
              // Revoked, or carrying some legacy status this build does not
              // know. Either way a row already exists for this person, so
              // update THAT row by id — never insert a second one.
              toReactivateIds.push(existing.id);
              draft[p.idx].outcome = 'reactivated';
            } else {
              toCreate.push(p.email);
              draft[p.idx].outcome = 'added';
            }
          }

          // Two statements regardless of list size — a per-address upsert loop
          // would hold the advisory lock for 200 round-trips and blow the
          // interactive-transaction timeout.
          if (toCreate.length > 0) {
            await tx.allowlistEntry.createMany({
              data: toCreate.map((email) => ({
                tenantId,
                email,
                status: GRANTED,
              })),
              skipDuplicates: true,
            });
          }
          if (toReactivateIds.length > 0) {
            await tx.allowlistEntry.updateMany({
              // By id, so a row stored under different casing is reactivated
              // rather than duplicated.
              where: { tenantId, id: { in: toReactivateIds } },
              data: { status: GRANTED, grantedAt: new Date(), revokedAt: null },
            });
          }

          // Same repair as the single-grant path: revoking cut the live account
          // off as well, so restoring has to put it back or the engineer keeps
          // failing the session heartbeat with a perfectly green allowlist row.
          // Matched in JS after lowercasing, because `in` on a text column is
          // case-sensitive and these rows predate normalisation.
          const restored = new Set([
            ...toCreate,
            ...toReactivateIds.map((id) => byId.get(id) ?? ''),
          ]);
          restored.delete('');
          if (restored.size > 0) {
            const revokedAccounts = await tx.connectedAccount.findMany({
              where: { tenantId, status: REVOKED },
              select: { id: true, email: true },
            });
            const toRestore = revokedAccounts
              .filter((a) => restored.has(a.email.toLowerCase().trim()))
              .map((a) => a.id);
            if (toRestore.length > 0) {
              await tx.connectedAccount.updateMany({
                where: { id: { in: toRestore } },
                data: { status: CONNECTED },
              });
            }
          }

          return {
            toInvite: [
              ...toCreate,
              ...toReactivateIds.map((id) =>
                entries
                  .find((e) => e.id === id)!
                  .email.toLowerCase()
                  .trim(),
              ),
            ],
            companyName: tenant.companyName,
            used: activeCount,
            limit: seatLimit,
          };
        },
        // The lock plus two bulk writes are quick, but the lock may be held by a
        // concurrent paste; give it room rather than failing the admin's request.
        { timeout: 30_000, maxWait: 15_000 },
      );

    // Committed. Safe to promise these people an email.
    for (const email of toInvite) {
      await this.enqueueInvite(email, companyName);
    }

    const results: BulkGrantRow[] = draft.map((d) => ({
      email: d.email,
      // Every pending row is assigned in pass 2; the fallback only exists so
      // the type is honest.
      outcome: d.outcome ?? 'invalid',
    }));

    const summary: Record<BulkGrantOutcome, number> = {
      added: 0,
      reactivated: 0,
      duplicate: 0,
      invalid: 0,
      over_limit: 0,
    };
    for (const r of results) summary[r.outcome]++;

    this.logger.log(
      `Bulk grant on tenant ${tenantId}: ${summary.added} added, ` +
        `${summary.reactivated} reactivated, ${summary.duplicate} duplicate, ` +
        `${summary.invalid} invalid, ${summary.over_limit} over limit`,
    );

    return { results, summary, seats: { used, limit } };
  }

  /**
   * Called during OAuth (AuthService.handleGoogleCallback and SE login). If the
   * email is not on any tenant's allowlist as granted/verified, the sign-in is
   * rejected even though Google approved the permissions. Otherwise the entry is
   * marked verified so we know this account has completed the badge-in.
   *
   * Returns the tenant the email was granted under, so the caller can stamp it
   * onto the ConnectedAccount + JWT. This is what makes revokeAccess/offboard
   * (which match the live account by tenantId + email) actually reach an SE's
   * account, and gives SE tokens a real tenant before DEP-1 lands.
   */
  async verifyAccess(
    rawEmail: string,
    tenantId?: string,
  ): Promise<{ tenantId: string }> {
    const email = rawEmail.toLowerCase().trim();
    const entry = await this.prisma.allowlistEntry.findFirst({
      where: {
        email: { equals: email, mode: 'insensitive' },
        status: { in: [GRANTED, VERIFIED] },
        ...(tenantId ? { tenantId } : {}),
      },
      orderBy: { grantedAt: 'desc' },
    });

    if (!entry) {
      throw new ForbiddenException('This email is not on any allowlist');
    }

    if (entry.status !== VERIFIED) {
      await this.prisma.allowlistEntry.update({
        where: { id: entry.id },
        data: { status: VERIFIED, verifiedAt: new Date() },
      });
    }

    return { tenantId: entry.tenantId };
  }

  /**
   * Cuts off one SE immediately. Flips BOTH the allowlist entry and the live
   * ConnectedAccount to revoked in a single transaction — so access is gone
   * right now, not whenever the OAuth token happens to expire on its own.
   */
  async revokeAccess(
    tenantId: string,
    rawEmail: string,
  ): Promise<{ outcome: RevokeOutcome }> {
    const email = rawEmail.toLowerCase().trim();

    // Matched case-insensitively. The old exact match was worse here than in the
    // grant paths: a row stored 'Temp@Gmail.com' simply did not match a revoke
    // for 'temp@gmail.com', updateMany quietly reported zero rows changed, and
    // the admin was told access was revoked while the engineer kept working.
    const entry = await this.prisma.allowlistEntry.findFirst({
      where: { tenantId, email: { equals: email, mode: 'insensitive' } },
      select: { id: true, status: true, email: true },
    });

    if (!entry) {
      this.logger.warn(
        `Revoke requested for ${email} on tenant ${tenantId}, but no entry exists`,
      );
      return { outcome: 'not_found' };
    }
    if (entry.status === REVOKED) {
      // Already off. Do not rewrite revokedAt and do not send a second notice —
      // a double-click must not mail someone twice.
      return { outcome: 'already_revoked' };
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { companyName: true },
    });

    await this.prisma.$transaction([
      this.prisma.allowlistEntry.update({
        where: { id: entry.id },
        data: { status: REVOKED, revokedAt: new Date() },
      }),
      this.prisma.connectedAccount.updateMany({
        // The stored address may differ in case from the pasted one; match the
        // way verifyAccess does so the live session is actually cut off.
        where: { tenantId, email: { equals: email, mode: 'insensitive' } },
        data: { status: REVOKED },
      }),
    ]);

    // Only after the revocation is committed. Telling someone their access is
    // gone while the write could still roll back would be worse than silence.
    await this.enqueueRevokedNotice(
      entry.email,
      tenant?.companyName ?? 'Sales Copilot',
    );

    this.logger.log(`Revoked access for ${email} on tenant ${tenantId}`);
    return { outcome: 'revoked' };
  }

  /**
   * Offboards a whole tenant: revokes EVERY allowlist entry and EVERY connected
   * account for the tenant, then marks the tenant offboarded — all in one
   * transaction. No client data is deleted; it simply becomes unreachable
   * because every account that could sign in is locked.
   */
  async offboardTenant(tenantId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.allowlistEntry.updateMany({
        where: { tenantId },
        data: { status: REVOKED, revokedAt: new Date() },
      }),
      this.prisma.connectedAccount.updateMany({
        where: { tenantId },
        data: { status: REVOKED },
      }),
      this.prisma.tenant.update({
        where: { id: tenantId },
        data: { status: 'offboarded' },
      }),
    ]);
    this.logger.log(`Offboarded tenant ${tenantId}`);
  }

  /** Lists a tenant's SEs for the team-management dashboard. */
  async listAllowlist(tenantId: string) {
    const [entries, accounts] = await Promise.all([
      this.prisma.allowlistEntry.findMany({
        where: { tenantId },
        select: {
          email: true,
          status: true,
          grantedAt: true,
          verifiedAt: true,
          revokedAt: true,
        },
        orderBy: { grantedAt: 'desc' },
      }),
      this.prisma.connectedAccount.findMany({
        where: { OR: [{ tenantId }, { tenantId: null }] },
        select: {
          email: true,
          lastLoginAt: true,
          createdAt: true,
          status: true,
        },
      }),
    ]);

    const accountMap = new Map(
      accounts.map((a) => [a.email.toLowerCase().trim(), a]),
    );

    return entries.map((entry) => {
      const key = entry.email.toLowerCase().trim();
      const account = accountMap.get(key);
      const isConnected = !!(account && account.status !== 'revoked');
      const status =
        entry.status === 'revoked'
          ? 'revoked'
          : isConnected || entry.verifiedAt || entry.status === 'verified'
            ? 'verified'
            : 'granted';
      return {
        ...entry,
        status,
        verifiedAt:
          entry.verifiedAt ??
          (isConnected ? (account.lastLoginAt ?? account.createdAt) : null),
      };
    });
  }
}
