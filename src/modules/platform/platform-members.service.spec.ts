import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PlatformMembersService } from './platform-members.service';
import type { PrismaService } from '../../database/prisma.service';
import type { GoogleGrantRevoker } from './google-grant-revoker';

type Row = Record<string, unknown>;

interface Fixture {
  tenant?: Row | null;
  entries?: Row[];
  accounts?: Row[];
  /** The single row `findFirst` should return for each table, if any. */
  entryMatch?: Row | null;
  accountMatch?: Row | null;
}

function makeService(fx: Fixture) {
  const order: string[] = [];
  const revokeAll = jest.fn().mockImplementation(() => {
    order.push('revoke');
    return Promise.resolve();
  });
  const entryDelete = jest.fn().mockReturnValue({ __op: 'entryDelete' });
  const accountDelete = jest.fn().mockReturnValue({ __op: 'accountDelete' });
  const transaction = jest.fn().mockImplementation((ops: unknown[]) => {
    order.push('delete');
    return Promise.resolve(ops);
  });

  const prisma = {
    $transaction: transaction,
    tenant: {
      findUnique: jest
        .fn()
        .mockResolvedValue(fx.tenant === undefined ? { id: 't1' } : fx.tenant),
    },
    allowlistEntry: {
      findMany: jest.fn().mockResolvedValue(fx.entries ?? []),
      findFirst: jest.fn().mockResolvedValue(fx.entryMatch ?? null),
      delete: entryDelete,
    },
    connectedAccount: {
      findMany: jest.fn().mockResolvedValue(fx.accounts ?? []),
      findFirst: jest.fn().mockResolvedValue(fx.accountMatch ?? null),
      delete: accountDelete,
    },
  } as unknown as PrismaService;

  const revoker = { revokeAll } as unknown as GoogleGrantRevoker;
  return {
    service: new PlatformMembersService(prisma, revoker),
    revokeAll,
    entryDelete,
    accountDelete,
    transaction,
    order,
  };
}

describe('PlatformMembersService', () => {
  describe('list', () => {
    it('refuses an unknown tenant rather than returning an empty roster', async () => {
      const { service } = makeService({ tenant: null });
      await expect(service.list('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('merges a seat and its mailbox into one member', async () => {
      const granted = new Date('2026-01-01');
      const login = new Date('2026-02-02');
      const { service } = makeService({
        entries: [
          { email: 'se@acme.com', status: 'verified', grantedAt: granted },
        ],
        accounts: [
          {
            email: 'se@acme.com',
            status: 'connected',
            isAdmin: false,
            createdAt: new Date('2026-01-15'),
            lastLoginAt: login,
          },
        ],
      });

      const members = await service.list('t1');

      expect(members).toEqual([
        {
          email: 'se@acme.com',
          role: 'se',
          seatStatus: 'verified',
          accountStatus: 'connected',
          connected: true,
          // The seat's grant date wins over the mailbox's createdAt.
          addedAt: granted,
          lastLoginAt: login,
        },
      ]);
    });

    it('does not list one person twice when the two rows differ in case', async () => {
      const { service } = makeService({
        entries: [
          { email: 'SE@Acme.com', status: 'granted', grantedAt: new Date() },
        ],
        accounts: [
          {
            email: 'se@acme.com',
            status: 'connected',
            isAdmin: false,
            createdAt: new Date(),
            lastLoginAt: null,
          },
        ],
      });

      const members = await service.list('t1');

      expect(members).toHaveLength(1);
      expect(members[0].email).toBe('se@acme.com');
      expect(members[0].seatStatus).toBe('granted');
      expect(members[0].connected).toBe(true);
    });

    it('keeps an invited engineer who never connected a mailbox', async () => {
      const { service } = makeService({
        entries: [
          { email: 'new@acme.com', status: 'granted', grantedAt: new Date() },
        ],
        accounts: [],
      });

      const [member] = await service.list('t1');

      expect(member.connected).toBe(false);
      expect(member.accountStatus).toBeNull();
      expect(member.lastLoginAt).toBeNull();
    });

    it('keeps a mailbox whose seat was already revoked away', async () => {
      const created = new Date('2026-03-03');
      const { service } = makeService({
        entries: [],
        accounts: [
          {
            email: 'ghost@acme.com',
            status: 'revoked',
            isAdmin: false,
            createdAt: created,
            lastLoginAt: null,
          },
        ],
      });

      const [member] = await service.list('t1');

      expect(member.seatStatus).toBeNull();
      expect(member.accountStatus).toBe('revoked');
      // Falls back to the mailbox's own creation date.
      expect(member.addedAt).toBe(created);
    });

    it('sorts the admin first, then by address', async () => {
      const { service } = makeService({
        entries: [],
        accounts: [
          {
            email: 'zoe@acme.com',
            status: 'connected',
            isAdmin: false,
            createdAt: new Date(),
            lastLoginAt: null,
          },
          {
            email: 'boss@acme.com',
            status: 'connected',
            isAdmin: true,
            createdAt: new Date(),
            lastLoginAt: null,
          },
          {
            email: 'adam@acme.com',
            status: 'connected',
            isAdmin: false,
            createdAt: new Date(),
            lastLoginAt: null,
          },
        ],
      });

      const members = await service.list('t1');

      expect(members.map((m) => m.email)).toEqual([
        'boss@acme.com',
        'adam@acme.com',
        'zoe@acme.com',
      ]);
      expect(members[0].role).toBe('admin');
    });
  });

  describe('remove', () => {
    it('rejects something that is not an email address', async () => {
      const { service, transaction } = makeService({});
      await expect(service.remove('t1', 'not-an-email')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(transaction).not.toHaveBeenCalled();
    });

    it('refuses an unknown tenant', async () => {
      const { service } = makeService({ tenant: null });
      await expect(
        service.remove('nope', 'se@acme.com'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reports a member who is not in this workspace instead of succeeding', async () => {
      const { service, transaction } = makeService({
        entryMatch: null,
        accountMatch: null,
      });
      await expect(
        service.remove('t1', 'stranger@acme.com'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(transaction).not.toHaveBeenCalled();
    });

    it('deletes the seat and the mailbox, and frees the address', async () => {
      const { service, entryDelete, accountDelete, transaction } = makeService({
        entryMatch: { id: 'e1' },
        accountMatch: {
          id: 'a1',
          isAdmin: false,
          refreshToken: 'enc',
          email: 'se@acme.com',
        },
      });

      const result = await service.remove('t1', 'SE@Acme.com');

      expect(entryDelete).toHaveBeenCalledWith({ where: { id: 'e1' } });
      expect(accountDelete).toHaveBeenCalledWith({ where: { id: 'a1' } });
      expect((transaction.mock.calls[0] as unknown[])[0]).toHaveLength(2);
      expect(result).toEqual({
        email: 'se@acme.com',
        removedSeat: true,
        removedAccount: true,
        wasAdmin: false,
      });
    });

    it('revokes the Google grant BEFORE deleting the row that holds the token', async () => {
      const { service, order, revokeAll } = makeService({
        entryMatch: { id: 'e1' },
        accountMatch: {
          id: 'a1',
          isAdmin: false,
          refreshToken: 'enc',
          email: 'se@acme.com',
        },
      });

      await service.remove('t1', 'se@acme.com');

      expect(revokeAll).toHaveBeenCalled();
      // Reversed, the token is gone and the grant stays live forever.
      expect(order).toEqual(['revoke', 'delete']);
    });

    it('removes an invited engineer who has no mailbox to revoke', async () => {
      const { service, revokeAll, accountDelete, transaction } = makeService({
        entryMatch: { id: 'e1' },
        accountMatch: null,
      });

      const result = await service.remove('t1', 'new@acme.com');

      expect(revokeAll).not.toHaveBeenCalled();
      expect(accountDelete).not.toHaveBeenCalled();
      expect((transaction.mock.calls[0] as unknown[])[0]).toHaveLength(1);
      expect(result).toEqual({
        email: 'new@acme.com',
        removedSeat: true,
        removedAccount: false,
        wasAdmin: false,
      });
    });

    it('tells the caller when the removed member was the workspace admin', async () => {
      const { service } = makeService({
        entryMatch: { id: 'e1' },
        accountMatch: {
          id: 'a1',
          isAdmin: true,
          refreshToken: null,
          email: 'boss@acme.com',
        },
      });

      const result = await service.remove('t1', 'boss@acme.com');

      expect(result.wasAdmin).toBe(true);
    });
  });
});
