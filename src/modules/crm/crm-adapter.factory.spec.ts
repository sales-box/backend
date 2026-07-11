import { Test, TestingModule } from '@nestjs/testing';
import { CrmAdapterFactory } from './crm-adapter.factory';
import { PrismaService } from '../../database/prisma.service';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../auth/crypto.service';
import { CrmProvider } from './crm.constants';
import { MockCrmAdapter } from './mock-crm.adapter';
import { HubSpotAdapter } from './hubspot-crm.adapter';

describe('CrmAdapterFactory', () => {
  let factory: CrmAdapterFactory;
  let prisma: { crmConnection: { findUnique: jest.Mock } };
  let config: { get: jest.Mock };
  let crypto: { decrypt: jest.Mock };

  beforeEach(async () => {
    prisma = {
      crmConnection: {
        findUnique: jest.fn(),
      },
    };
    config = {
      get: jest.fn(),
    };
    crypto = {
      decrypt: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmAdapterFactory,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: CryptoService, useValue: crypto },
      ],
    }).compile();

    factory = module.get<CrmAdapterFactory>(CrmAdapterFactory);
  });

  it('returns MockCrmAdapter immediately if global provider is mock', async () => {
    config.get.mockReturnValue('mock');

    const adapter = await factory.getAdapterForTenant('tenant-1');

    expect(adapter).toBeInstanceOf(MockCrmAdapter);
    expect(prisma.crmConnection.findUnique).not.toHaveBeenCalled();
  });

  it('returns null if tenant has no connection in DB', async () => {
    config.get.mockReturnValue('hubspot');
    prisma.crmConnection.findUnique.mockResolvedValue(null);

    const adapter = await factory.getAdapterForTenant('tenant-1');

    expect(adapter).toBeNull();
    expect(prisma.crmConnection.findUnique).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1' },
    });
  });

  it('returns MockCrmAdapter if DB connection provider is mock', async () => {
    config.get.mockReturnValue('hubspot');
    prisma.crmConnection.findUnique.mockResolvedValue({
      provider: CrmProvider.Mock,
      status: 'connected',
      apiKey: 'some-key',
    });

    const adapter = await factory.getAdapterForTenant('tenant-1');

    expect(adapter).toBeInstanceOf(MockCrmAdapter);
  });

  it('returns HubSpotAdapter with decrypted key if DB connection provider is hubspot', async () => {
    config.get.mockReturnValue('hubspot');
    prisma.crmConnection.findUnique.mockResolvedValue({
      provider: CrmProvider.HubSpot,
      status: 'connected',
      apiKey: 'encrypted-api-key',
    });
    crypto.decrypt.mockReturnValue('decrypted-api-key');

    const adapter = await factory.getAdapterForTenant('tenant-1');

    expect(adapter).toBeInstanceOf(HubSpotAdapter);
    expect(crypto.decrypt).toHaveBeenCalledWith('encrypted-api-key');
  });
});
