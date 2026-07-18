/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Queue } from 'bullmq';
import { CrmService } from './crm.service';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService } from '../auth/crypto.service';
import { CrmAdapterFactory } from './crm-adapter.factory';
import { ClientsService } from '../clients/clients.service';
import {
  SYNC_CONTACT_JOB,
  CREATE_DEAL_JOB,
  LOG_NOTE_JOB,
  CrmProvider,
} from './crm.constants';
import { makeMockClient } from './crm.test-fixtures';
import { BadRequestException } from '@nestjs/common';

describe('CrmService', () => {
  let queue: { add: jest.Mock };
  let prisma: {
    crmConnection: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      delete: jest.Mock;
    };
    client: { deleteMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let crypto: { encrypt: jest.Mock; decrypt: jest.Mock };
  let factory: { getAdapterForTenant: jest.Mock };
  let clientsService: { getOrCreateClient: jest.Mock };
  let service: CrmService;

  const tenantId = 'tenant-123';

  beforeEach(() => {
    queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    prisma = {
      crmConnection: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      client: {
        deleteMany: jest.fn(),
      },
      // Execute the array of prisma operations, mirroring $transaction([...]).
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    crypto = {
      encrypt: jest.fn().mockReturnValue('encrypted-api-key'),
      decrypt: jest.fn().mockReturnValue('decrypted-api-key'),
    };
    factory = {
      getAdapterForTenant: jest.fn(),
    };
    clientsService = {
      getOrCreateClient: jest.fn(),
    };

    service = new CrmService(
      queue as unknown as Queue,
      prisma as unknown as PrismaService,
      crypto as unknown as CryptoService,
      factory as unknown as CrmAdapterFactory,
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

    it('deletes the connection and CRM-imported clients in one transaction', async () => {
      prisma.crmConnection.findUnique.mockResolvedValue({
        tenantId,
        status: 'connected',
      });
      prisma.client.deleteMany.mockResolvedValue({ count: 3 });
      prisma.crmConnection.delete.mockResolvedValue({ tenantId });

      const result = await service.disconnectCrm(tenantId);

      expect(result).toEqual({
        message: 'CRM disconnected — removed 3 imported clients.',
        removedClients: 3,
        status: 'disconnected',
      });
      // Only CRM-sourced clients (crmId set) are removed.
      expect(prisma.client.deleteMany).toHaveBeenCalledWith({
        where: { tenantId, crmId: { not: null } },
      });
      expect(prisma.crmConnection.delete).toHaveBeenCalledWith({
        where: { tenantId },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('enqueueContactSync', () => {
    it('adds a sync-contact job carrying the client and tenantId', async () => {
      const client = makeMockClient();
      await service.enqueueContactSync(tenantId, client);

      expect(queue.add).toHaveBeenCalledTimes(1);
      const [jobName, data] = queue.add.mock.calls[0];
      expect(jobName).toBe(SYNC_CONTACT_JOB);
      expect(data).toEqual({ tenantId, client });
    });

    it('configures 3 attempts with exponential backoff', async () => {
      await service.enqueueContactSync(tenantId, makeMockClient());

      const opts = queue.add.mock.calls[0][2];
      expect(opts.attempts).toBe(3);
      expect(opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
      expect(opts.removeOnFail).toBe(false);
    });
  });

  describe('enqueueDealSync', () => {
    it('adds a create-deal job with contact, tenantId and deal data', async () => {
      await service.enqueueDealSync(
        tenantId,
        'c-1',
        'jane@acme.com',
        'product_inquiry',
        'Pricing',
        'Acme',
      );

      expect(queue.add).toHaveBeenCalledTimes(1);
      const [jobName, data] = queue.add.mock.calls[0];
      expect(jobName).toBe(CREATE_DEAL_JOB);
      expect(data).toEqual({
        tenantId,
        contactId: 'c-1',
        email: 'jane@acme.com',
        classification: 'product_inquiry',
        subject: 'Pricing',
        company: 'Acme',
      });
    });
  });

  describe('enqueueEngagementNote', () => {
    it('adds a log-note job with contact, tenantId and note payload', async () => {
      const note = {
        subject: 'Hello',
        summary: 'Test email',
        classification: 'product_inquiry',
        sentAt: '2026-07-09T00:00:00Z',
      };
      await service.enqueueEngagementNote(tenantId, 'c-1', note);

      expect(queue.add).toHaveBeenCalledTimes(1);
      const [jobName, data] = queue.add.mock.calls[0];
      expect(jobName).toBe(LOG_NOTE_JOB);
      expect(data).toEqual({ tenantId, contactId: 'c-1', note });
    });
  });
});
