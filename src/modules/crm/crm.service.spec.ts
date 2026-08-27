/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { CrmService } from './crm.service';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService } from '../auth/crypto.service';
import { ClientsService } from '../clients/clients.service';
import { CrmProvider } from './crm.constants';
import { BadRequestException } from '@nestjs/common';
import type { CrmContact } from './crm.interface';

// connectCrm builds a real HubSpotAdapter and calls fetchContacts to verify the
// credential. Without this the suite would reach hubapi.com on every run.
// Same reason for Zoho: connectZohoMcp now builds a real adapter and reads the
// address book, so without this the suite would reach the MCP server.
const mockZohoFetch: jest.Mock<Promise<CrmContact[]>, []> = jest.fn();
jest.mock('./zoho-crm.adapter', () => ({
  ZohoMcpAdapter: jest.fn().mockImplementation(() => ({
    fetchContacts: (): Promise<CrmContact[]> => mockZohoFetch(),
  })),
}));
jest.mock('./zoho-mcp.verify', () => ({
  verifyZohoMcpServer: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./hubspot-crm.adapter', () => ({
  HubSpotAdapter: jest.fn().mockImplementation(() => ({
    fetchContacts: jest
      .fn()
      .mockResolvedValue([
        { email: 'imported@example.com', name: 'Imported Person', crmId: '1' },
      ]),
  })),
}));

describe('CrmService', () => {
  let prisma: {
    crmConnection: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      delete: jest.Mock;
    };
    client: {
      deleteMany: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
    crmAgentConnection: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      deleteMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let crypto: { encrypt: jest.Mock; decrypt: jest.Mock };
  let clientsService: { getOrCreateClient: jest.Mock };
  let service: CrmService;

  const tenantId = 'tenant-123';

  beforeEach(() => {
    prisma = {
      crmConnection: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      client: {
        deleteMany: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      crmAgentConnection: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      // Execute the array of prisma operations, mirroring $transaction([...]).
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    crypto = {
      encrypt: jest.fn().mockReturnValue('encrypted-api-key'),
      decrypt: jest.fn().mockReturnValue('decrypted-api-key'),
    };
    clientsService = {
      getOrCreateClient: jest.fn(),
    };
    mockZohoFetch.mockResolvedValue([
      {
        email: 'zoho-lead@acme.co',
        name: 'Zoho Lead',
        crmId: 'z-1',
        status: 'qualified',
      },
      { email: 'zoho-contact@acme.co', name: 'Zoho Contact', crmId: 'z-2' },
    ]);

    service = new CrmService(
      prisma as unknown as PrismaService,
      crypto as unknown as CryptoService,
      clientsService as unknown as ClientsService,
    );
  });

  describe('getCrmStatus', () => {
    it('returns connected: false if connection does not exist', async () => {
      prisma.crmConnection.findUnique.mockResolvedValue(null);

      const status = await service.getCrmStatus(tenantId);

      expect(status).toEqual({ connected: false, status: 'disconnected' });
      expect(prisma.crmConnection.findUnique).toHaveBeenCalledWith({
        where: { tenantId },
      });
    });

    it('returns connected: true details if connection exists', async () => {
      const mockConn = {
        provider: CrmProvider.HubSpot,
        status: 'connected',
        updatedAt: new Date(),
      };
      prisma.crmConnection.findUnique.mockResolvedValue(mockConn);

      const status = await service.getCrmStatus(tenantId);

      expect(status).toEqual({
        connected: true,
        provider: CrmProvider.HubSpot,
        status: 'connected',
        lastSync: mockConn.updatedAt,
        importedCount: 0,
      });
    });

    // The panel used to read this off the connect mutation, so a reload showed
    // 0 synced contacts for a workspace that had imported hundreds.
    it('counts the clients that carry a CRM id', async () => {
      prisma.crmConnection.findUnique.mockResolvedValue({
        provider: CrmProvider.HubSpot,
        status: 'connected',
        updatedAt: new Date(),
      });
      prisma.client.count.mockResolvedValue(12);

      const status = await service.getCrmStatus(tenantId);

      expect(status).toMatchObject({ importedCount: 12 });
      expect(prisma.client.count).toHaveBeenCalledWith({
        where: { tenantId, crmId: { not: null } },
      });
    });
  });

  describe('connectCrm', () => {
    it('connects to CRM, encrypts key, upserts and imports contacts', async () => {
      prisma.crmConnection.upsert.mockResolvedValue({ status: 'connected' });

      // Mock hubspot client creation internally by mocking mockCrmAdapter/HubspotAdapter
      // Since it's instantiated via `new HubSpotAdapter(body.apiKey)` or Mock,
      // let's pass provider as 'mock' for easy testing
      const result = await service.connectCrm(tenantId, {
        provider: CrmProvider.Mock,
        apiKey: 'test-key',
      });

      expect(result.status).toBe('connected');
      expect(result.importedCount).toBe(2); // MockCrmAdapter returns 2 contacts in fetchContacts
      expect(crypto.encrypt).toHaveBeenCalledWith('test-key');
      expect(prisma.crmConnection.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId },
          create: expect.objectContaining({
            tenantId,
            provider: CrmProvider.Mock,
            apiKey: 'encrypted-api-key',
          }),
        }),
      );
      expect(clientsService.getOrCreateClient).toHaveBeenCalledTimes(2);
    });

    it('throws BadRequestException if verification fails', async () => {
      // Test invalid provider
      await expect(
        service.connectCrm(tenantId, {
          provider: 'invalid' as any,
          apiKey: 'key',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('connect means connected (phase 4) and one CRM per tenant (phase 5)', () => {
    it('makes the connected provider the agent CRM, so the agent can find it', async () => {
      prisma.crmConnection.upsert.mockResolvedValue({ status: 'connected' });

      await service.connectCrm(tenantId, {
        provider: CrmProvider.HubSpot,
        apiKey: 'test-key',
      });

      expect(prisma.crmAgentConnection.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId },
          update: { provider: CrmProvider.HubSpot, mcpServerUrl: null },
        }),
      );
    });

    it('does not make the mock provider the agent CRM', async () => {
      prisma.crmConnection.upsert.mockResolvedValue({ status: 'connected' });

      await service.connectCrm(tenantId, {
        provider: CrmProvider.Mock,
        apiKey: 'test-key',
      });

      expect(prisma.crmAgentConnection.upsert).not.toHaveBeenCalled();
    });

    it('refuses a second provider and names the way out', async () => {
      prisma.crmAgentConnection.findUnique.mockResolvedValue({
        provider: CrmProvider.Zoho,
      });

      await expect(
        service.connectCrm(tenantId, {
          provider: CrmProvider.HubSpot,
          apiKey: 'test-key',
        }),
      ).rejects.toThrow(/zoho is already connected.*Disconnect it/i);
    });

    it('allows reconnecting the same provider', async () => {
      prisma.crmAgentConnection.findUnique.mockResolvedValue({
        provider: CrmProvider.HubSpot,
      });
      prisma.crmConnection.upsert.mockResolvedValue({ status: 'connected' });

      await expect(
        service.connectCrm(tenantId, {
          provider: CrmProvider.HubSpot,
          apiKey: 'new-key',
        }),
      ).resolves.toEqual(expect.objectContaining({ status: 'connected' }));
    });

    it('clears the agent CRM on disconnect so it never points at a dead credential', async () => {
      prisma.crmConnection.findUnique.mockResolvedValue({
        tenantId,
        status: 'connected',
        provider: CrmProvider.HubSpot,
      });
      prisma.client.updateMany.mockResolvedValue({ count: 0 });
      prisma.crmConnection.delete.mockResolvedValue({ tenantId });

      await service.disconnectCrm(tenantId);

      expect(prisma.crmAgentConnection.deleteMany).toHaveBeenCalledWith({
        where: { tenantId, provider: CrmProvider.HubSpot },
      });
    });
  });

  describe('disconnectCrm', () => {
    it('is idempotent — no connection means nothing to remove', async () => {
      prisma.crmConnection.findUnique.mockResolvedValue(null);

      const result = await service.disconnectCrm(tenantId);

      expect(result).toEqual({
        message: 'No CRM connection to disconnect.',
        removedClients: 0,
        status: 'disconnected',
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.crmConnection.delete).not.toHaveBeenCalled();
    });

    it('never deletes a client — Interaction cascades, so a delete here destroys the history', async () => {
      prisma.crmConnection.findUnique.mockResolvedValue({
        tenantId,
        status: 'connected',
      });
      prisma.client.updateMany.mockResolvedValue({ count: 2 });
      prisma.crmConnection.delete.mockResolvedValue({ tenantId });

      await service.disconnectCrm(tenantId);

      expect(prisma.client.deleteMany).not.toHaveBeenCalled();
    });

    it('leaves locally-created clients alone — they never had a crmId to clear', async () => {
      prisma.crmConnection.findUnique.mockResolvedValue({
        tenantId,
        status: 'connected',
      });
      prisma.client.updateMany.mockResolvedValue({ count: 0 });
      prisma.crmConnection.delete.mockResolvedValue({ tenantId });

      await service.disconnectCrm(tenantId);

      expect(prisma.client.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId, crmId: { not: null } } }),
      );
    });

    it('deletes the connection and unlinks CRM-imported clients in one transaction', async () => {
      prisma.crmConnection.findUnique.mockResolvedValue({
        tenantId,
        status: 'connected',
      });
      prisma.client.updateMany.mockResolvedValue({ count: 3 });
      prisma.crmConnection.delete.mockResolvedValue({ tenantId });

      const result = await service.disconnectCrm(tenantId);

      expect(result).toEqual({
        message: 'CRM disconnected — 3 clients kept with their history.',
        removedClients: 3,
        status: 'disconnected',
      });
      // Only CRM-sourced clients (crmId set) are touched.
      expect(prisma.client.updateMany).toHaveBeenCalledWith({
        where: { tenantId, crmId: { not: null } },
        data: { crmId: null },
      });
      expect(prisma.crmConnection.delete).toHaveBeenCalledWith({
        where: { tenantId },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  // Zoho used to stop at verification: it wrote one row and imported nothing,
  // so a connected Zoho workspace showed an empty Clients page for ever and
  // the generic status/disconnect routes could not see it at all.
  describe('Zoho reaches parity with HubSpot', () => {
    const mcpServerUrl = 'https://zoho.test/mcp/x';

    it('imports contacts on connect, like HubSpot does', async () => {
      const res = await service.connectZohoMcp(tenantId, { mcpServerUrl });

      expect(clientsService.getOrCreateClient).toHaveBeenCalledTimes(2);
      expect(clientsService.getOrCreateClient).toHaveBeenCalledWith(
        tenantId,
        'zoho-lead@acme.co',
        'Zoho Lead',
        undefined,
        'z-1',
        'qualified',
      );
      expect(res).toMatchObject({ connected: true, importedCount: 2 });
    });

    // Every feature keyed off crm_connections — getCrmStatus, importedCount,
    // disconnectCrm — was blind to Zoho without this row.
    it('writes the credential row as well as the agent row', async () => {
      await service.connectZohoMcp(tenantId, { mcpServerUrl });

      expect(prisma.crmConnection.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            provider: CrmProvider.Zoho,
            status: 'connected',
          }),
        }),
      );
      expect(prisma.crmAgentConnection.upsert).toHaveBeenCalled();
      // The MCP URL is the credential here, so it is encrypted like a key.
      expect(crypto.encrypt).toHaveBeenCalledWith(mcpServerUrl);
    });

    it('refuses the connection when the address book cannot be read', async () => {
      mockZohoFetch.mockRejectedValue(new Error('no read permission'));

      await expect(
        service.connectZohoMcp(tenantId, { mcpServerUrl }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.crmConnection.upsert).not.toHaveBeenCalled();
      expect(prisma.crmAgentConnection.upsert).not.toHaveBeenCalled();
    });

    it('unlinks clients on disconnect, keeping their history', async () => {
      prisma.crmConnection.findUnique.mockResolvedValue({
        provider: CrmProvider.Zoho,
        status: 'connected',
      });
      prisma.client.updateMany.mockResolvedValue({ count: 2 });

      const res = await service.disconnectZohoMcp(tenantId);

      expect(prisma.client.updateMany).toHaveBeenCalledWith({
        where: { tenantId, crmId: { not: null } },
        data: { crmId: null },
      });
      expect(prisma.crmConnection.delete).toHaveBeenCalled();
      expect(res).toMatchObject({ connected: false, removedClients: 2 });
    });

    // The unscoped delete that used to be here took HubSpot's agent row down
    // while the dashboard still read "Connected".
    it('scopes the agent-row cleanup to Zoho', async () => {
      prisma.crmConnection.findUnique.mockResolvedValue(null);

      await service.disconnectZohoMcp(tenantId);

      expect(prisma.crmAgentConnection.deleteMany).toHaveBeenCalledWith({
        where: { tenantId, provider: CrmProvider.Zoho },
      });
    });
  });
});
