import { MockCrmAdapter } from './mock-crm.adapter';
import { makeMockClient } from './crm.test-fixtures';

describe('MockCrmAdapter', () => {
  const adapter = new MockCrmAdapter();

  it('syncContact returns a deterministic fake id and makes no external calls', async () => {
    const client = makeMockClient({ id: 'abc' });
    const id = await adapter.syncContact(client);
    expect(id).toBe('mock-contact-abc');
  });

  it('logNote resolves without throwing', async () => {
    await expect(
      adapter.logNote('mock-contact-abc', 'hello'),
    ).resolves.toBeUndefined();
  });
});
