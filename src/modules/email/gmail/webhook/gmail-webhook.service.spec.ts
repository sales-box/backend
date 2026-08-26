/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/database/prisma.service';
import { GmailClientFactory } from '@/modules/email/gmail/gmail-client.factory';
import { GmailWebhookService } from './gmail-webhook.service';

type Handler = (p: { id: string; email: string }) => Promise<void>;

function build(
  watchResult: unknown,
  watchThrows = false,
  isAdmin = false,
  tenantId: string | null = 'tenant-a',
) {
  const watch = watchThrows
    ? jest.fn().mockRejectedValue(new Error('watch failed'))
    : jest.fn().mockResolvedValue(watchResult);
  const labels = {
    list: jest.fn().mockResolvedValue({
      data: { labels: [{ id: 'Label_salesbox', name: 'salesbox' }] },
    }),
  };
  const createClient = jest
    .fn()
    .mockResolvedValue({ users: { watch, labels } });
  const factory = { createClient } as unknown as GmailClientFactory;

  const upsert = jest.fn().mockResolvedValue({});
  const findUnique = jest.fn().mockResolvedValue({ isAdmin, tenantId });
  const prisma = {
    webhookSubscription: { upsert },
    connectedAccount: { findUnique },
  } as unknown as PrismaService;

  const config = {
    getOrThrow: jest.fn().mockReturnValue('projects/x/topics/gmail'),
  } as unknown as ConfigService;

  const service = new GmailWebhookService(prisma, factory, config);
  const trigger = (
    service as unknown as { handleGoogleAccountConnected: Handler }
  ).handleGoogleAccountConnected;
  return {
    service,
    trigger: trigger.bind(service),
    upsert,
    watch,
    findUnique,
    createClient,
  };
}

describe('GmailWebhookService', () => {
  it('builds the Gmail client scoped to the account tenant', async () => {
    const { trigger, createClient } = build({
      data: { expiration: '1893456000000', historyId: 12345 },
    });

    await trigger({ id: 'acct-1', email: 'se@acme.com' });

    const calls = createClient.mock.calls as Array<[string, string]>;
    expect(calls[0]).toEqual(['tenant-a', 'se@acme.com']);
  });

  it('skips the watch entirely when the account has no tenant yet', async () => {
    const { trigger, createClient, watch } = build(
      { data: { expiration: '1893456000000', historyId: 12345 } },
      false,
      false,
      null,
    );

    await trigger({ id: 'acct-orphan', email: 'pending@acme.com' });

    expect(createClient).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
  });

  it('skips watch subscription for admin accounts (isAdmin: true)', async () => {
    const { trigger, upsert, watch } = build(
      { data: { expiration: '1893456000000', historyId: 12345 } },
      false,
      true, // isAdmin = true
    );

    await trigger({ id: 'acct-admin', email: 'admin@acme.com' });

    expect(watch).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('seeds lastHistoryId on CREATE from the watch response historyId for SE accounts', async () => {
    const { trigger, upsert } = build({
      data: { expiration: '1893456000000', historyId: 12345 },
    });

    await trigger({ id: 'acct-1', email: 'se@acme.com' });

    const arg = upsert.mock.calls[0][0] as {
      create: { lastHistoryId: string | null };
    };
    expect(arg.create.lastHistoryId).toBe('12345');
  });

  it('does NOT touch lastHistoryId on UPDATE (renewal must not re-anchor the baseline)', async () => {
    const { trigger, upsert } = build({
      data: { expiration: '1893456000000', historyId: 12345 },
    });

    await trigger({ id: 'acct-1', email: 'se@acme.com' });

    // The load-bearing invariant: the update branch never carries lastHistoryId,
    // so a daily renewal cannot silently skip unprocessed messages.
    const arg = upsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(arg.update).not.toHaveProperty('lastHistoryId');
  });

  it('stores lastHistoryId = null when the watch response omits historyId', async () => {
    const { trigger, upsert } = build({
      data: { expiration: '1893456000000' },
    });

    await trigger({ id: 'acct-1', email: 'se@acme.com' });

    const arg = upsert.mock.calls[0][0] as {
      create: { lastHistoryId: string | null };
    };
    expect(arg.create.lastHistoryId).toBeNull();
  });

  it('swallows a watch() failure (logs, never rethrows, no upsert)', async () => {
    const { trigger, upsert } = build(null, true);

    await expect(
      trigger({ id: 'acct-1', email: 'se@acme.com' }),
    ).resolves.toBeUndefined();
    expect(upsert).not.toHaveBeenCalled();
  });
});
