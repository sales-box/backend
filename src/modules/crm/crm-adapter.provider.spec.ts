import { ConfigService } from '@nestjs/config';
import { crmAdapterProvider } from './crm-adapter.provider';
import { CrmProvider } from './crm.constants';
import { MockCrmAdapter } from './mock-crm.adapter';
import { HubSpotAdapter } from './hubspot-crm.adapter';

jest.mock('@hubspot/api-client', () => ({
  Client: jest.fn().mockImplementation(() => ({ crm: {} })),
  AssociationTypes: { noteToContact: 202 },
}));

type Factory = (config: ConfigService) => unknown;

function makeConfig(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
    getOrThrow: (key: string) => {
      if (values[key] === undefined) throw new Error(`missing ${key}`);
      return values[key];
    },
  } as unknown as ConfigService;
}

describe('crmAdapterProvider', () => {
  const factory = (crmAdapterProvider as { useFactory: Factory }).useFactory;

  it('builds a MockCrmAdapter when CRM_PROVIDER=mock', () => {
    const adapter = factory(makeConfig({ CRM_PROVIDER: CrmProvider.Mock }));
    expect(adapter).toBeInstanceOf(MockCrmAdapter);
  });

  it('defaults to MockCrmAdapter when CRM_PROVIDER is unset', () => {
    const adapter = factory(makeConfig({}));
    expect(adapter).toBeInstanceOf(MockCrmAdapter);
  });

  it('builds a HubSpotAdapter when CRM_PROVIDER=hubspot', () => {
    const adapter = factory(
      makeConfig({
        CRM_PROVIDER: CrmProvider.HubSpot,
        HUBSPOT_API_KEY: 'fake-key',
      }),
    );
    expect(adapter).toBeInstanceOf(HubSpotAdapter);
  });
});
