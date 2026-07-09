/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method */
import { Job } from 'bullmq';
import { CrmProcessor } from './crm.processor';
import { ICrmAdapter } from './crm.interface';
import { PrismaService } from '../../database/prisma.service';
import { makeMockClient } from './crm.test-fixtures';
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
    ...overrides,
  };
}

function makePrisma(
  overrides: Partial<{ client: { update: jest.Mock } }> = {},
) {
  return {
    client: { update: jest.fn().mockResolvedValue({}), ...overrides.client },
  } as unknown as PrismaService;
}

function makeJob(
  name: string,
  data: Record<string, unknown>,
  client = makeMockClient(),
): Job {
  const jobData = name === SYNC_CONTACT_JOB ? { client, ...data } : data;
  return {
    id: 'job-1',
    name,
    attemptsMade: 0,
    data: jobData,
  } as unknown as Job;
}

describe('CrmProcessor', () => {
  describe('sync-contact', () => {
    it('delegates to adapter and persists crmId in DB', async () => {
      const adapter = makeAdapter();
      const prisma = makePrisma();
      const processor = new CrmProcessor(adapter, prisma);
      const client = makeMockClient();

      const result = await processor.process(
        makeJob(SYNC_CONTACT_JOB, {}, client),
      );

      expect(adapter.syncContact).toHaveBeenCalledWith(client);
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { email: client.email },
        data: { crmId: 'contact-42' },
      });
      expect(result).toEqual({ contactId: 'contact-42' });
    });

    it('lets adapter errors propagate so BullMQ retries', async () => {
      const adapter = makeAdapter({
        syncContact: jest.fn().mockRejectedValue(new Error('CRM down')),
      });
      const processor = new CrmProcessor(adapter, makePrisma());

      await expect(
        processor.process(makeJob(SYNC_CONTACT_JOB, {})),
      ).rejects.toThrow('CRM down');
    });
  });

  describe('create-deal', () => {
    it('delegates to adapter and persists dealId in DB', async () => {
      const adapter = makeAdapter();
      const prisma = makePrisma();
      const processor = new CrmProcessor(adapter, prisma);

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
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { email: 'jane@acme.com' },
        data: { dealId: 'deal-99' },
      });
      expect(result).toEqual({ dealId: 'deal-99' });
    });
  });

  describe('log-note', () => {
    it('delegates to adapter.logEngagementNote', async () => {
      const adapter = makeAdapter();
      const processor = new CrmProcessor(adapter, makePrisma());
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

    it('log-note failure does not affect create-deal', async () => {
      const adapter = makeAdapter({
        logEngagementNote: jest
          .fn()
          .mockRejectedValue(new Error('note failed')),
      });
      const processor = new CrmProcessor(adapter, makePrisma());

      await expect(
        processor.process(
          makeJob(LOG_NOTE_JOB, {
            contactId: 'c-1',
            note: {
              subject: 'x',
              summary: 'y',
              classification: 'z',
              sentAt: 'now',
            },
          }),
        ),
      ).rejects.toThrow('note failed');

      // create-deal still works independently
      const result = await processor.process(
        makeJob(CREATE_DEAL_JOB, {
          contactId: 'c-1',
          email: 'jane@acme.com',
          classification: 'product_inquiry',
          subject: 'Pricing',
          company: 'Acme',
        }),
      );
      expect(result).toEqual({ dealId: 'deal-99' });
    });
  });
});
