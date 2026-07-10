import { ConfigService } from '@nestjs/config';
import { Client } from '@hubspot/api-client';
import { crmAdapterProvider } from './crm-adapter.provider';
import { CrmProvider } from './crm.constants';
import { MockCrmAdapter } from './mock-crm.adapter';
import type { ICrmAdapter, NotePayload } from './crm.interface';
import { makeMockClient } from './crm.test-fixtures';

// The HubSpot SDK's Client is the ONLY path to HubSpot's network. Mock it so we
// can prove it is never constructed when CRM_PROVIDER=mock — i.e. zero HubSpot
// calls. A future edit that reaches for HubSpot on the mock path fails here.
jest.mock('@hubspot/api-client', () => ({
  Client: jest.fn().mockImplementation(() => ({ crm: {} })),
  AssociationTypes: { noteToContact: 202 },
}));

type Factory = (config: ConfigService) => ICrmAdapter;

function makeConfig(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

describe('MockCrmAdapter makes zero HubSpot calls', () => {
  const factory = (crmAdapterProvider as { useFactory: Factory }).useFactory;
  const ClientMock = Client as unknown as jest.Mock;

  const note: NotePayload = {
    subject: 'Hello',
    summary: 'A short summary',
    classification: 'lead',
    sentAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => ClientMock.mockClear());

  it('selects the mock adapter and never builds the HubSpot client', () => {
    const adapter = factory(makeConfig({ CRM_PROVIDER: CrmProvider.Mock }));

    expect(adapter).toBeInstanceOf(MockCrmAdapter);
    expect(ClientMock).not.toHaveBeenCalled();
  });

  it('runs every CRM operation with fake data and no HubSpot client', async () => {
    const adapter = factory(makeConfig({ CRM_PROVIDER: CrmProvider.Mock }));

    const contactId = await adapter.syncContact(makeMockClient());
    const dealId = await adapter.createOrUpdateDeal(
      contactId,
      'lead',
      'Subject',
      'Acme',
    );
    await adapter.logEngagementNote(contactId, note);

    expect(contactId).toBe('mock-contact-client-123');
    expect(dealId).toBe('mock-deal-mock-contact-client-123');
    expect(ClientMock).not.toHaveBeenCalled();
  });
});
