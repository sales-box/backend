/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/database/prisma.service';
import { GmailClientFactory } from '@/modules/email/gmail/gmail-client.factory';
import { GmailWebhookService } from './gmail-webhook.service';

type Handler = (p: { id: string; email: string }) => Promise<void>;

function build(watchResult: unknown, watchThrows = false) {
  const watch = watchThrows
    ? jest.fn().mockRejectedValue(new Error('watch failed'))
    : jest.fn().mockResolvedValue(watchResult);
  const factory = {
    createClient: jest.fn().mockResolvedValue({ users: { watch } }),
  } as unknown as GmailClientFactory;

  const upsert = jest.fn().mockResolvedValue({});
  const prisma = {
    webhookSubscription: { upsert },
  } as unknown as PrismaService;

  const config = {
    getOrThrow: jest.fn().mockReturnValue('projects/x/topics/gmail'),
  } as unknown as ConfigService;

  const service = new GmailWebhookService(prisma, factory, config);
  const trigger = (
    service as unknown as { handleGoogleAccountConnected: Handler }
  ).handleGoogleAccountConnected;
  return { service, trigger: trigger.bind(service), upsert, watch };
}

describe('GmailWebhookService', () => {
  it('seeds lastHistoryId on CREATE from the watch response historyId', async () => {
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
