/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method */
import { Job } from 'bullmq';
import { CrmProcessor } from './crm.processor';
import { ICrmAdapter } from './crm.interface';
import { PrismaService } from '../../database/prisma.service';
import { makeMockClient } from './crm.test-fixtures';
import { CrmAdapterFactory } from './crm-adapter.factory';
import {
  SYNC_CONTACT_JOB,
  CREATE_DEAL_JOB,
  LOG_NOTE_JOB,
} from './crm.constants';

function makeAdapter(overrides: Partial<ICrmAdapter> = {}): ICrmAdapter {
  return {
    syncContact: jest.fn().mockResolvedValue('contact-42'),
    createOrUpdateDeal: jest.fn().mockResolvedValue('deal-99'),
    logEngagementNote: jest.fn().mockResolvedValue(undefined),
    getContactByEmail: jest.fn(),
    fetchContacts: jest.fn(),
    ...overrides,
  };
}

function makePrisma(
  overrides: Partial<{
    client: { update: jest.Mock; updateMany: jest.Mock };
  }> = {},
) {
  return {
    client: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({}),
      ...overrides.client,
    },
  } as unknown as PrismaService;
}

const tenantId = 'tenant-99';

function makeJob(
  name: string,
  data: Record<string, unknown>,
  client = makeMockClient(),
): Job {
  const jobData =
    name === SYNC_CONTACT_JOB
      ? { tenantId, client, ...data }
      : { tenantId, ...data };
  return {
    id: 'job-1',
    name,
    attemptsMade: 0,
    data: jobData,
  } as unknown as Job;
}

describe('CrmProcessor', () => {
  describe('sync-contact', () => {
    it('delegates to adapter resolved by factory and persists crmId in DB', async () => {
      const adapter = makeAdapter();
      const factory = {
        getAdapterForTenant: jest.fn().mockResolvedValue(adapter),
      } as unknown as CrmAdapterFactory;
      const prisma = makePrisma();
      const processor = new CrmProcessor(factory, prisma);
      const client = makeMockClient();

      const result = await processor.process(
        makeJob(SYNC_CONTACT_JOB, {}, client),
      );

      expect(factory.getAdapterForTenant).toHaveBeenCalledWith(tenantId);
      expect(adapter.syncContact).toHaveBeenCalledWith(client);
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: client.id },
        data: { crmId: 'contact-42' },
      });
      expect(result).toEqual({ contactId: 'contact-42' });
    });

    it('lets adapter errors propagate so BullMQ retries', async () => {
      const adapter = makeAdapter({
        syncContact: jest.fn().mockRejectedValue(new Error('CRM down')),
      });
      const factory = {
        getAdapterForTenant: jest.fn().mockResolvedValue(adapter),
      } as unknown as CrmAdapterFactory;
      const processor = new CrmProcessor(factory, makePrisma());

      await expect(
        processor.process(makeJob(SYNC_CONTACT_JOB, {})),
      ).rejects.toThrow('CRM down');
    });

    it('skips silently without error if factory returns null adapter', async () => {
      const factory = {
        getAdapterForTenant: jest.fn().mockResolvedValue(null),
      } as unknown as CrmAdapterFactory;
      const prisma = makePrisma();
      const processor = new CrmProcessor(factory, prisma);

      const result = await processor.process(makeJob(SYNC_CONTACT_JOB, {}));

      expect(prisma.client.update).not.toHaveBeenCalled();
      expect(result).toEqual({});
    });
  });

  describe('create-deal', () => {
    it('delegates to adapter and persists dealId in DB', async () => {
      const adapter = makeAdapter();
      const factory = {
        getAdapterForTenant: jest.fn().mockResolvedValue(adapter),
      } as unknown as CrmAdapterFactory;
      const prisma = makePrisma();
      const processor = new CrmProcessor(factory, prisma);

      const result = await processor.process(
        makeJob(CREATE_DEAL_JOB, {
          contactId: 'c-1',
          email: 'jane@acme.com',
          classification: 'product_inquiry',
          subject: 'Pricing',
          company: 'Acme',
        }),
      );

      expect(adapter.createOrUpdateDeal).toHaveBeenCalledWith(
        'c-1',
        'product_inquiry',
        'Pricing',
        'Acme',
      );
      expect(prisma.client.updateMany).toHaveBeenCalledWith({
        where: { tenantId, email: 'jane@acme.com' },
        data: { dealId: 'deal-99' },
      });
      expect(result).toEqual({ dealId: 'deal-99' });
    });
  });

  describe('log-note', () => {
    it('delegates to adapter.logEngagementNote', async () => {
      const adapter = makeAdapter();
      const factory = {
        getAdapterForTenant: jest.fn().mockResolvedValue(adapter),
      } as unknown as CrmAdapterFactory;
      const processor = new CrmProcessor(factory, makePrisma());
      const note = {
        subject: 'Hello',
        summary: 'Test',
        classification: 'product_inquiry',
        sentAt: '2026-07-09T00:00:00Z',
      };

      const result = await processor.process(
        makeJob(LOG_NOTE_JOB, { contactId: 'c-1', note }),
      );

      expect(adapter.logEngagementNote).toHaveBeenCalledWith('c-1', note);
      expect(result).toEqual({ ok: true });
    });
  });
});
