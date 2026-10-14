import { MockCrmAdapter } from './mock-crm.adapter';

describe('MockCrmAdapter', () => {
  const adapter = new MockCrmAdapter();

  it('getContactByEmail returns mock contact id', async () => {
    const res = await adapter.getContactByEmail('alice@acme.com');
    expect(res).toEqual({ id: 'mock-contact-alice-acme.com' });
  });

  it('getContactByEmail returns null for nonexistent emails', async () => {
    const res = await adapter.getContactByEmail('nonexistent-email@acme.com');
    expect(res).toBeNull();
  });

  it('fetchContacts returns predefined mock contacts', async () => {
    const res = await adapter.fetchContacts();
    expect(res).toHaveLength(2);
    expect(res[0].email).toBe('crm-user-1@acme.com');
  });

  it('carries a status so the import path is exercised without a live CRM', async () => {
    const res = await adapter.fetchContacts();
    expect(res.map((c) => c.status)).toEqual(['customer', 'qualified']);
  });
});
