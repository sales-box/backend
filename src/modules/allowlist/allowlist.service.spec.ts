import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AllowlistService } from './allowlist.service';
import { PrismaService } from '@/database/prisma.service';
import { EmailNotifyService } from '../email-notify/email-notify.service';
import type { Queue } from 'bullmq';
import type { SendSeInviteJobData } from './allowlist.constants';

type UpdateArg = {
  where: Record<string, string>;
  data: { status: string; verifiedAt?: Date; revokedAt?: Date };
};

describe('AllowlistService', () => {
  let prisma: {
    allowlistEntry: {
      findFirst: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
      createMany: jest.Mock;
      create: jest.Mock;
    };
    connectedAccount: { updateMany: jest.Mock; findMany: jest.Mock };
    tenant: { update: jest.Mock; findUnique: jest.Mock };
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
  };
  let email: { sendSeInvite: jest.Mock; sendSeRevoked: jest.Mock };
  let inviteQueue: { add: jest.Mock };
  let service: AllowlistService;

  beforeEach(() => {
    prisma = {
      allowlistEntry: {
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
        upsert: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({}),
      },
      connectedAccount: {
        updateMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      tenant: { update: jest.fn(), findUnique: jest.fn() },
      // Two shapes are used in this service: an ARRAY of operations (revoke,
      // offboard) and an interactive CALLBACK (grantAccessBulk). Support both,
      // and hand the callback the same mock so writes are observable.
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
          : Promise.resolve(undefined),
      ),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    email = { sendSeInvite: jest.fn(), sendSeRevoked: jest.fn() };
    inviteQueue = { add: jest.fn().mockResolvedValue(undefined) };
    service = new AllowlistService(
      prisma as unknown as PrismaService,
      email as unknown as EmailNotifyService,
      inviteQueue as unknown as Queue<SendSeInviteJobData>,
    );
  });

  /** First-call, first-arg of a mock, narrowed to the shape the test expects. */
  const callArg = <T>(mock: jest.Mock): T =>
    (mock.mock.calls as unknown as T[][])[0][0];

  /** First-call, first-arg of a mock, typed so assertions stay type-safe. */
  const firstArg = (mock: jest.Mock): UpdateArg => {
    const calls = mock.mock.calls as UpdateArg[][];
    return calls[0][0];
  };

  describe('verifyAccess', () => {
    it('throws Forbidden when the email is on no allowlist', async () => {
      prisma.allowlistEntry.findFirst.mockResolvedValue(null);
      await expect(service.verifyAccess('ghost@x.com')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.allowlistEntry.update).not.toHaveBeenCalled();
    });

    it('marks a granted entry as verified and returns its tenant', async () => {
      prisma.allowlistEntry.findFirst.mockResolvedValue({
        id: 'e1',
        status: 'granted',
        tenantId: 't1',
      });
      const result = await service.verifyAccess('se@acme.com');

      const arg = firstArg(prisma.allowlistEntry.update);
      expect(arg.where).toEqual({ id: 'e1' });
      expect(arg.data.status).toBe('verified');
      expect(arg.data.verifiedAt).toBeInstanceOf(Date);
      // Caller stamps this onto the ConnectedAccount + token.
      expect(result).toEqual({ tenantId: 't1' });
    });

    it('filters by tenantId when tenantId parameter is supplied', async () => {
      prisma.allowlistEntry.findFirst.mockResolvedValue({
        id: 'e2',
        status: 'granted',
        tenantId: 't2',
      });
      const result = await service.verifyAccess('se@acme.com', 't2');

      expect(prisma.allowlistEntry.findFirst).toHaveBeenCalledWith({
        where: {
          email: { equals: 'se@acme.com', mode: 'insensitive' },
          status: { in: ['granted', 'verified'] },
          tenantId: 't2',
        },
        orderBy: { grantedAt: 'desc' },
      });
      expect(result).toEqual({ tenantId: 't2' });
    });
  });

  describe('revokeAccess', () => {
    /** The row the revoke is aimed at. */
    const onFile = (status = 'verified', email = 'se@acme.com') =>
      prisma.allowlistEntry.findFirst.mockResolvedValue({
        id: 'row-1',
        status,
        email,
      });

    /** Job name + payload of the Nth queued mail. */
    const queued = (n = 0) =>
      (inviteQueue.add.mock.calls as [string, { email: string }][])[n];

    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue({ companyName: 'Acme Corp' });
    });

    it('revokes the entry and the connected account together', async () => {
      onFile();
      const res = await service.revokeAccess('t1', 'se@acme.com');

      expect(res).toEqual({ outcome: 'revoked' });
      const entryArg = callArg<{
        where: { id: string };
        data: { status: string };
      }>(prisma.allowlistEntry.update);
      expect(entryArg.where).toEqual({ id: 'row-1' });
      expect(entryArg.data.status).toBe('revoked');

      expect(prisma.connectedAccount.updateMany).toHaveBeenCalledWith({
        where: {
          tenantId: 't1',
          email: { equals: 'se@acme.com', mode: 'insensitive' },
        },
        data: { status: 'revoked' },
      });
      // Both updates must go through ONE transaction (atomic — no half-fail).
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('emails the engineer that their access has ended', async () => {
      onFile();
      await service.revokeAccess('t1', 'se@acme.com');

      expect(inviteQueue.add).toHaveBeenCalledTimes(1);
      const [jobName, data] = queued();
      expect(jobName).toBe('send-se-revoked');
      expect(data).toEqual({ email: 'se@acme.com', companyName: 'Acme Corp' });
    });

    it('queues the notice only AFTER the revocation commits', async () => {
      onFile();
      let queuedDuringTransaction = 0;
      prisma.$transaction.mockImplementation((arg: unknown) => {
        queuedDuringTransaction = inviteQueue.add.mock.calls.length;
        return typeof arg === 'function'
          ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
          : Promise.resolve(undefined);
      });

      await service.revokeAccess('t1', 'se@acme.com');

      // Nobody is told their access is gone while the write could still roll back.
      expect(queuedDuringTransaction).toBe(0);
      expect(inviteQueue.add).toHaveBeenCalledTimes(1);
    });

    it('looks the row up case-insensitively', async () => {
      // The old exact match let 'Temp@Gmail.com' survive a revoke aimed at
      // 'temp@gmail.com': updateMany reported zero rows changed, the admin was
      // told access was revoked, and the engineer kept working.
      //
      // Asserted on the QUERY, not on a returned row — a mocked findFirst hands
      // back whatever it was given regardless of the where clause, so checking
      // the result here would pass even with exact matching restored.
      onFile('verified', 'Temp@Gmail.com');
      await service.revokeAccess('t1', 'temp@gmail.com');

      const lookup = callArg<{
        where: { email: { equals: string; mode: string } };
      }>(prisma.allowlistEntry.findFirst);
      expect(lookup.where.email).toEqual({
        equals: 'temp@gmail.com',
        mode: 'insensitive',
      });
    });

    it('revokes the row it found, by id, not by the address typed', async () => {
      onFile('verified', 'Temp@Gmail.com');
      const res = await service.revokeAccess('t1', 'temp@gmail.com');

      expect(res).toEqual({ outcome: 'revoked' });
      const arg = callArg<{ where: { id: string } }>(
        prisma.allowlistEntry.update,
      );
      expect(arg.where.id).toBe('row-1');
      // And the notice goes to the address as STORED, so the mail reaches them.
      expect(queued()[1]).toEqual({
        email: 'Temp@Gmail.com',
        companyName: 'Acme Corp',
      });
    });

    it('does nothing and sends no second notice when already revoked', async () => {
      onFile('revoked');
      const res = await service.revokeAccess('t1', 'se@acme.com');

      expect(res).toEqual({ outcome: 'already_revoked' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.allowlistEntry.update).not.toHaveBeenCalled();
      expect(inviteQueue.add).not.toHaveBeenCalled();
    });

    it('reports not_found without writing or emailing', async () => {
      prisma.allowlistEntry.findFirst.mockResolvedValue(null);
      const res = await service.revokeAccess('t1', 'ghost@acme.com');

      expect(res).toEqual({ outcome: 'not_found' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(inviteQueue.add).not.toHaveBeenCalled();
    });

    it('still revokes when the notice cannot be queued', async () => {
      onFile();
      inviteQueue.add.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.revokeAccess('t1', 'se@acme.com')).resolves.toEqual({
        outcome: 'revoked',
      });
      // Fell back to sending inline rather than failing the revocation.
      expect(email.sendSeRevoked).toHaveBeenCalledWith(
        'se@acme.com',
        'Acme Corp',
      );
    });
  });

  describe('offboardTenant', () => {
    it('revokes all entries + accounts and marks the tenant offboarded', async () => {
      await service.offboardTenant('t1');

      const entryArg = firstArg(prisma.allowlistEntry.updateMany);
      expect(entryArg.where).toEqual({ tenantId: 't1' });
      expect(entryArg.data.status).toBe('revoked');

      expect(prisma.connectedAccount.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 't1' },
        data: { status: 'revoked' },
      });
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { status: 'offboarded' },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('grantAccess', () => {
    it('throws NotFound when the tenant does not exist', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      await expect(
        service.grantAccess('missing', 'x@acme.com'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects when the tenant is at its tier SE limit', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: 't1', tier: 1 }); // cap 3
      prisma.allowlistEntry.count.mockResolvedValue(3);

      await expect(
        service.grantAccess('t1', 'new@acme.com'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.allowlistEntry.upsert).not.toHaveBeenCalled();
      expect(email.sendSeInvite).not.toHaveBeenCalled();
    });

    it('grants and emails an invite when under the limit', async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: 't1',
        tier: 2,
        companyName: 'Acme Corp',
      }); // cap 10
      prisma.allowlistEntry.count.mockResolvedValue(4);
      prisma.allowlistEntry.findFirst.mockResolvedValue(null); // nobody by that address yet

      const res = await service.grantAccess('t1', 'new@acme.com');

      expect(res).toEqual({ outcome: 'added' });
      expect(prisma.allowlistEntry.create).toHaveBeenCalledTimes(1);
      // The invite goes to the queue, not straight to SMTP, so a slow or
      // failing mail server never delays (or silently loses) the grant.
      expect(inviteQueue.add).toHaveBeenCalledTimes(1);
      const [, jobData] = inviteQueue.add.mock.calls[0] as [
        string,
        { email: string; companyName: string },
      ];
      expect(jobData).toEqual({
        email: 'new@acme.com',
        companyName: 'Acme Corp',
      });
      expect(email.sendSeInvite).not.toHaveBeenCalled();
    });

    it('puts a revoked live account back on a single re-grant', async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: 't1',
        tier: 2,
        companyName: 'Acme Corp',
      });
      prisma.allowlistEntry.count.mockResolvedValue(1);
      prisma.allowlistEntry.findFirst.mockResolvedValue({
        id: 'row-gone',
        status: 'revoked',
      });

      await service.grantAccess('t1', 'back@acme.com');

      const arg = callArg<{
        where: { status: string; email: { equals: string; mode: string } };
        data: { status: string };
      }>(prisma.connectedAccount.updateMany);
      // Only a REVOKED account is flipped; a connected one is left alone.
      expect(arg.where.status).toBe('revoked');
      expect(arg.where.email).toEqual({
        equals: 'back@acme.com',
        mode: 'insensitive',
      });
      expect(arg.data.status).toBe('connected');
    });

    it('does not re-grant, re-date or re-invite someone already on the team', async () => {
      // Reported from manual testing: inviting an address that was already on
      // the team said "Invite sent", demoted the engineer from verified back to
      // granted, moved their "Date added" to today, and mailed them a second
      // install-the-extension invite. The team page still showed them as
      // Verified, because listAllowlist derives the shown status from the
      // connected account — so the demotion was invisible.
      prisma.tenant.findUnique.mockResolvedValue({
        id: 't1',
        tier: 2,
        companyName: 'Acme Corp',
      });
      prisma.allowlistEntry.findFirst.mockResolvedValue({
        id: 'row-1',
        status: 'verified',
      });

      const res = await service.grantAccess('t1', 'onteam@acme.com');

      expect(res).toEqual({ outcome: 'duplicate' });
      expect(prisma.allowlistEntry.create).not.toHaveBeenCalled();
      expect(prisma.allowlistEntry.update).not.toHaveBeenCalled();
      expect(prisma.allowlistEntry.upsert).not.toHaveBeenCalled();
      expect(inviteQueue.add).not.toHaveBeenCalled();
    });

    it('re-adding an existing member is allowed even at the seat cap', async () => {
      // They already hold their seat, so refusing with "at your plan limit"
      // would send the admin off to buy seats they do not need.
      prisma.tenant.findUnique.mockResolvedValue({
        id: 't1',
        tier: 1,
        companyName: 'Acme Corp',
      });
      prisma.allowlistEntry.count.mockResolvedValue(3); // full
      prisma.allowlistEntry.findFirst.mockResolvedValue({
        id: 'row-1',
        status: 'granted',
      });

      await expect(
        service.grantAccess('t1', 'onteam@acme.com'),
      ).resolves.toEqual({ outcome: 'duplicate' });
    });

    it('reactivates a revoked member by id and invites them again', async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: 't1',
        tier: 2,
        companyName: 'Acme Corp',
      });
      prisma.allowlistEntry.count.mockResolvedValue(1);
      prisma.allowlistEntry.findFirst.mockResolvedValue({
        id: 'row-gone',
        status: 'revoked',
      });

      const res = await service.grantAccess('t1', 'back@acme.com');

      expect(res).toEqual({ outcome: 'reactivated' });
      expect(prisma.allowlistEntry.create).not.toHaveBeenCalled();
      const arg = callArg<{ where: { id: string } }>(
        prisma.allowlistEntry.update,
      );
      expect(arg.where.id).toBe('row-gone');
      expect(inviteQueue.add).toHaveBeenCalledTimes(1);
    });

    it('still sends inline when the queue is unreachable', async () => {
      // Redis being down must not cost the SE their welcome email.
      prisma.tenant.findUnique.mockResolvedValue({
        id: 't1',
        tier: 2,
        companyName: 'Acme Corp',
      });
      prisma.allowlistEntry.count.mockResolvedValue(0);
      prisma.allowlistEntry.findFirst.mockResolvedValue(null);
      inviteQueue.add.mockRejectedValue(new Error('ECONNREFUSED'));

      // The grant still succeeds; only the delivery route changed.
      await expect(service.grantAccess('t1', 'new@acme.com')).resolves.toEqual({
        outcome: 'added',
      });

      expect(email.sendSeInvite).toHaveBeenCalledWith(
        'new@acme.com',
        'Acme Corp',
      );
    });
  });

  describe('grantAccessBulk', () => {
    /** Tier 2 = 10 seats, per TIER_SE_LIMITS. */
    const tenant = { id: 't1', tier: 2, companyName: 'Acme Corp' };

    /** Maps the response rows to `email:outcome` so assertions read clearly. */
    const outcomes = (r: { results: { email: string; outcome: string }[] }) =>
      r.results.map((x) => `${x.email}:${x.outcome}`);

    const queuedEmails = () =>
      (inviteQueue.add.mock.calls as [string, { email: string }][]).map(
        ([, data]) => data.email,
      );

    /**
     * Seeds the tenant's existing allowlist. grantAccessBulk reads the whole
     * list once and derives BOTH "does this row exist" and the seat count from
     * it, so a test only has to describe the rows.
     */
    const existingRows = (
      rows: { email: string; status: string; id?: string }[],
    ) =>
      prisma.allowlistEntry.findMany.mockResolvedValue(
        rows.map((r, i) => ({ id: r.id ?? `row-${i}`, ...r })),
      );

    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue(tenant);
      existingRows([]);
    });

    it('adds new addresses and queues one invite each', async () => {
      const res = await service.grantAccessBulk('t1', [
        'ali@acme.com',
        'sara@acme.com',
      ]);

      expect(outcomes(res)).toEqual([
        'ali@acme.com:added',
        'sara@acme.com:added',
      ]);
      expect(res.summary.added).toBe(2);
      expect(res.seats).toEqual({ used: 2, limit: 10 });

      // One createMany, not one write per address.
      expect(prisma.allowlistEntry.createMany).toHaveBeenCalledTimes(1);
      expect(queuedEmails()).toEqual(['ali@acme.com', 'sara@acme.com']);
    });

    it('leaves an already-active address untouched and does NOT re-invite it', async () => {
      // The regression this whole method exists for: grantAccess() upserts
      // status=granted unconditionally, so re-pasting a list would demote every
      // verified SE and mail them all a second install-the-extension invite.
      existingRows([
        { email: 'verified@acme.com', status: 'verified' },
        { email: 'granted@acme.com', status: 'granted' },
      ]);

      const res = await service.grantAccessBulk('t1', [
        'verified@acme.com',
        'granted@acme.com',
        'new@acme.com',
      ]);

      expect(outcomes(res)).toEqual([
        'verified@acme.com:duplicate',
        'granted@acme.com:duplicate',
        'new@acme.com:added',
      ]);
      // Only the genuinely new address is written or emailed.
      expect(prisma.allowlistEntry.createMany).toHaveBeenCalledTimes(1);
      const createArg = callArg<{ data: { email: string }[] }>(
        prisma.allowlistEntry.createMany,
      );
      expect(createArg.data.map((d) => d.email)).toEqual(['new@acme.com']);
      expect(prisma.allowlistEntry.updateMany).not.toHaveBeenCalled();
      expect(queuedEmails()).toEqual(['new@acme.com']);
    });

    it('reactivates a revoked address and invites it again', async () => {
      existingRows([
        { id: 'row-back', email: 'back@acme.com', status: 'revoked' },
      ]);

      const res = await service.grantAccessBulk('t1', ['back@acme.com']);

      expect(outcomes(res)).toEqual(['back@acme.com:reactivated']);
      expect(prisma.allowlistEntry.createMany).not.toHaveBeenCalled();
      const arg = callArg<{
        where: { id: { in: string[] } };
        data: { status: string; revokedAt: null };
      }>(prisma.allowlistEntry.updateMany);
      // Updated BY ID, so a row stored under different casing is reactivated
      // instead of being duplicated.
      expect(arg.where.id.in).toEqual(['row-back']);
      expect(arg.data.status).toBe('granted');
      expect(arg.data.revokedAt).toBeNull();
      expect(queuedEmails()).toEqual(['back@acme.com']);
    });

    it('collapses repeats within the pasted list', async () => {
      const res = await service.grantAccessBulk('t1', [
        'dup@acme.com',
        'dup@acme.com',
        'DUP@ACME.COM',
      ]);

      expect(outcomes(res)).toEqual([
        'dup@acme.com:added',
        'dup@acme.com:duplicate',
        'dup@acme.com:duplicate',
      ]);
      // Exactly one row written and one invite — not three.
      const createArg = callArg<{ data: { email: string }[] }>(
        prisma.allowlistEntry.createMany,
      );
      expect(createArg.data).toHaveLength(1);
      expect(queuedEmails()).toEqual(['dup@acme.com']);
    });

    it('normalises case and surrounding whitespace before storing', async () => {
      const res = await service.grantAccessBulk('t1', ['  Foo@BAR.com  ']);

      expect(outcomes(res)).toEqual(['foo@bar.com:added']);
      const createArg = callArg<{ data: { email: string }[] }>(
        prisma.allowlistEntry.createMany,
      );
      expect(createArg.data[0].email).toBe('foo@bar.com');
    });

    it('reports junk rows as invalid without discarding the good ones', async () => {
      const res = await service.grantAccessBulk('t1', [
        'good@acme.com',
        'not an email',
        '',
        'missing@tld',
        'also.good@acme.com',
      ]);

      expect(outcomes(res)).toEqual([
        'good@acme.com:added',
        'not an email:invalid',
        ':invalid',
        'missing@tld:invalid',
        'also.good@acme.com:added',
      ]);
      expect(res.summary).toMatchObject({ added: 2, invalid: 3 });
      expect(queuedEmails()).toEqual(['good@acme.com', 'also.good@acme.com']);
    });

    it('fills seats in the order given and marks the overflow over_limit', async () => {
      // Tier 1 = 3 seats, 2 already used, so exactly one of the three fits.
      prisma.tenant.findUnique.mockResolvedValue({ ...tenant, tier: 1 });
      existingRows([
        { email: 'taken1@acme.com', status: 'granted' },
        { email: 'taken2@acme.com', status: 'verified' },
      ]);

      const res = await service.grantAccessBulk('t1', [
        'first@acme.com',
        'second@acme.com',
        'third@acme.com',
      ]);

      expect(outcomes(res)).toEqual([
        'first@acme.com:added',
        'second@acme.com:over_limit',
        'third@acme.com:over_limit',
      ]);
      expect(res.seats).toEqual({ used: 3, limit: 3 });
      // Rejected addresses must not be written or emailed.
      const createArg = callArg<{ data: { email: string }[] }>(
        prisma.allowlistEntry.createMany,
      );
      expect(createArg.data.map((d) => d.email)).toEqual(['first@acme.com']);
      expect(queuedEmails()).toEqual(['first@acme.com']);
    });

    it('writes nothing when the tenant is already at its cap', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ ...tenant, tier: 1 });
      existingRows([
        { email: 'taken1@acme.com', status: 'granted' },
        { email: 'taken2@acme.com', status: 'granted' },
        { email: 'taken3@acme.com', status: 'verified' },
      ]);

      const res = await service.grantAccessBulk('t1', ['nope@acme.com']);

      expect(outcomes(res)).toEqual(['nope@acme.com:over_limit']);
      expect(prisma.allowlistEntry.createMany).not.toHaveBeenCalled();
      expect(prisma.allowlistEntry.updateMany).not.toHaveBeenCalled();
      expect(inviteQueue.add).not.toHaveBeenCalled();
    });

    it('takes the per-tenant advisory lock before counting seats', async () => {
      // Without the lock two concurrent pastes both read the old count and
      // together overshoot the plan cap.
      await service.grantAccessBulk('t1', ['x@acme.com']);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('queues invites only after the transaction commits', async () => {
      let queuedDuringTransaction = 0;
      prisma.allowlistEntry.createMany.mockImplementation(() => {
        queuedDuringTransaction = inviteQueue.add.mock.calls.length;
        return Promise.resolve({ count: 1 });
      });

      await service.grantAccessBulk('t1', ['x@acme.com']);

      // Nothing promised anyone an email while the write could still roll back.
      expect(queuedDuringTransaction).toBe(0);
      expect(inviteQueue.add).toHaveBeenCalledTimes(1);
    });

    it('recognises a stored address that differs only by case', async () => {
      // Found by an adversarial review of the test plan. The lookup used to
      // compare the pasted address to the stored one EXACTLY, so a legacy row
      // written as 'Legacy.Person@Acme.TEST' did not match a pasted
      // 'legacy.person@acme.test'. The unique index is on the exact string, so
      // the miss did not collide either — it inserted a SECOND row and the same
      // human occupied two seats. verifyAccess already matches case
      // insensitively, so mixed-case rows are a state this code meets.
      existingRows([{ email: 'Legacy.Person@Acme.TEST', status: 'verified' }]);

      const res = await service.grantAccessBulk('t1', [
        'legacy.person@acme.test',
      ]);

      expect(outcomes(res)).toEqual(['legacy.person@acme.test:duplicate']);
      expect(prisma.allowlistEntry.createMany).not.toHaveBeenCalled();
      expect(inviteQueue.add).not.toHaveBeenCalled();
      // One person, one seat.
      expect(res.seats.used).toBe(1);
    });

    it('reactivates a revoked row stored under different casing, not a copy', async () => {
      existingRows([
        { id: 'row-legacy', email: 'Old.Name@Acme.TEST', status: 'revoked' },
      ]);

      const res = await service.grantAccessBulk('t1', ['old.name@acme.test']);

      expect(outcomes(res)).toEqual(['old.name@acme.test:reactivated']);
      expect(prisma.allowlistEntry.createMany).not.toHaveBeenCalled();
      const arg = callArg<{ where: { id: { in: string[] } } }>(
        prisma.allowlistEntry.updateMany,
      );
      expect(arg.where.id.in).toEqual(['row-legacy']);
      // The invite goes to the address as stored, normalised.
      expect(queuedEmails()).toEqual(['old.name@acme.test']);
    });

    it('reactivates a row carrying an unrecognised legacy status', async () => {
      // Not granted/verified, so it holds no seat; not revoked either. It must
      // still be treated as an existing row and repaired, never duplicated.
      existingRows([
        { id: 'row-odd', email: 'odd@acme.com', status: 'active' },
      ]);

      const res = await service.grantAccessBulk('t1', ['odd@acme.com']);

      expect(outcomes(res)).toEqual(['odd@acme.com:reactivated']);
      expect(prisma.allowlistEntry.createMany).not.toHaveBeenCalled();
      const arg = callArg<{ where: { id: { in: string[] } } }>(
        prisma.allowlistEntry.updateMany,
      );
      expect(arg.where.id.in).toEqual(['row-odd']);
    });

    it('counts only granted and verified rows against the seat cap', async () => {
      // Revoked and legacy-status rows must not silently consume seats.
      prisma.tenant.findUnique.mockResolvedValue({ ...tenant, tier: 1 });
      existingRows([
        { email: 'live@acme.com', status: 'granted' },
        { email: 'gone@acme.com', status: 'revoked' },
        { email: 'weird@acme.com', status: 'active' },
      ]);

      const res = await service.grantAccessBulk('t1', [
        'new1@acme.com',
        'new2@acme.com',
      ]);

      // Cap 3, one seat genuinely held, so both new addresses fit.
      expect(outcomes(res)).toEqual([
        'new1@acme.com:added',
        'new2@acme.com:added',
      ]);
      expect(res.seats).toEqual({ used: 3, limit: 3 });
    });

    it('rejects an address containing a colon', async () => {
      // Not pedantry. RFC 5322 reads "name: addr;" as an address GROUP and
      // nodemailer honours it, so 'colon:test@x.test' was stored on the
      // allowlist while the invite was delivered to 'test@x.test' — a different
      // mailbox, and one not on the allowlist at all.
      const res = await service.grantAccessBulk('t1', ['colon:test@x.test']);

      expect(outcomes(res)).toEqual(['colon:test@x.test:invalid']);
      expect(prisma.allowlistEntry.createMany).not.toHaveBeenCalled();
      expect(inviteQueue.add).not.toHaveBeenCalled();
    });

    it('rejects an address longer than the RFC 5321 limit', async () => {
      const tooLong = `${'x'.repeat(300)}@acme.com`;
      const res = await service.grantAccessBulk('t1', [tooLong, 'ok@acme.com']);

      expect(res.summary).toMatchObject({ invalid: 1, added: 1 });
      expect(queuedEmails()).toEqual(['ok@acme.com']);
    });

    it('accepts an address exactly at the length limit', async () => {
      // 254 total: local part + '@acme.com' (9 chars).
      const exact = `${'x'.repeat(245)}@acme.com`;
      expect(exact).toHaveLength(254);
      const res = await service.grantAccessBulk('t1', [exact]);
      expect(outcomes(res)).toEqual([`${exact}:added`]);
    });

    it('puts a revoked live account back when reactivating', async () => {
      // revokeAccess cuts off BOTH the allowlist entry and the ConnectedAccount.
      // Restoring only the entry left the engineer with a green row on the team
      // page and no way in — the session heartbeat rejects a revoked account.
      existingRows([
        { id: 'row-back', email: 'back@acme.com', status: 'revoked' },
      ]);
      prisma.connectedAccount.findMany.mockResolvedValue([
        { id: 'acct-1', email: 'Back@Acme.com' }, // stored with capitals
      ]);

      await service.grantAccessBulk('t1', ['back@acme.com']);

      const arg = callArg<{
        where: { id: { in: string[] } };
        data: { status: string };
      }>(prisma.connectedAccount.updateMany);
      expect(arg.where.id.in).toEqual(['acct-1']);
      expect(arg.data.status).toBe('connected');
    });

    it('does not touch accounts belonging to someone else', async () => {
      existingRows([
        { id: 'row-back', email: 'back@acme.com', status: 'revoked' },
      ]);
      prisma.connectedAccount.findMany.mockResolvedValue([
        { id: 'acct-other', email: 'someone.else@acme.com' },
      ]);

      await service.grantAccessBulk('t1', ['back@acme.com']);

      expect(prisma.connectedAccount.updateMany).not.toHaveBeenCalled();
    });

    it('throws NotFound for an unknown tenant', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      await expect(
        service.grantAccessBulk('ghost', ['x@acme.com']),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('handles an all-invalid list without touching the database', async () => {
      const res = await service.grantAccessBulk('t1', ['nope', '@@@']);
      expect(res.summary.invalid).toBe(2);
      expect(prisma.allowlistEntry.createMany).not.toHaveBeenCalled();
      expect(inviteQueue.add).not.toHaveBeenCalled();
    });
  });
});
