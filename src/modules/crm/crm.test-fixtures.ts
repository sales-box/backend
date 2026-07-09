import { ClientRecord } from '../clients/clients.interface';

export function makeMockClient(
  overrides: Partial<ClientRecord> = {},
): ClientRecord {
  return {
    id: 'client-123',
    email: 'jane.doe@acme.com',
    name: 'Jane Doe',
    company: 'Acme',
    status: 'new_inquiry',
    crmId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}
