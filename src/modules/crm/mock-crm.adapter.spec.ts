import { MockCrmAdapter } from './mock-crm.adapter';
import { makeMockClient } from './crm.test-fixtures';

describe('MockCrmAdapter', () => {
  const adapter = new MockCrmAdapter();

  it('syncContact returns a deterministic fake id', async () => {
    const client = makeMockClient({ id: 'abc' });
    const id = await adapter.syncContact(client);
    expect(id).toBe('mock-contact-abc');
  });

  it('createOrUpdateDeal returns a deterministic fake deal id', async () => {
    const id = await adapter.createOrUpdateDeal(
      'mock-contact-abc',
      'product_inquiry',
      'Pricing',
      'Acme',
    );
    expect(id).toBe('mock-deal-mock-contact-abc');
  });

  it('logEngagementNote resolves without throwing', async () => {
    await expect(
      adapter.logEngagementNote('mock-contact-abc', {
        subject: 'Hello',
        summary: 'Test',
        classification: 'product_inquiry',
        sentAt: '2026-07-09T00:00:00Z',
      }),
    ).resolves.toBeUndefined();
  });
});
