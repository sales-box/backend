/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Queue } from 'bullmq';
import { CrmService } from './crm.service';
import {
  SYNC_CONTACT_JOB,
  CREATE_DEAL_JOB,
  LOG_NOTE_JOB,
} from './crm.constants';
import { makeMockClient } from './crm.test-fixtures';

describe('CrmService', () => {
  let queue: { add: jest.Mock };
  let service: CrmService;

  beforeEach(() => {
    queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    service = new CrmService(queue as unknown as Queue);
  });

  describe('enqueueContactSync', () => {
    it('adds a sync-contact job carrying the client', async () => {
      const client = makeMockClient();
      await service.enqueueContactSync(client);

      expect(queue.add).toHaveBeenCalledTimes(1);
      const [jobName, data] = queue.add.mock.calls[0];
      expect(jobName).toBe(SYNC_CONTACT_JOB);
      expect(data).toEqual({ client });
    });

    it('configures 3 attempts with exponential backoff', async () => {
      await service.enqueueContactSync(makeMockClient());

      const opts = queue.add.mock.calls[0][2];
      expect(opts.attempts).toBe(3);
      expect(opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
      expect(opts.removeOnFail).toBe(false);
    });

    it('returns immediately (fire-and-forget)', async () => {
      await expect(
        service.enqueueContactSync(makeMockClient()),
      ).resolves.toBeUndefined();
    });
  });

  describe('enqueueDealSync', () => {
    it('adds a create-deal job with contact and deal data', async () => {
      await service.enqueueDealSync(
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
        contactId: 'c-1',
        email: 'jane@acme.com',
        classification: 'product_inquiry',
        subject: 'Pricing',
        company: 'Acme',
      });
    });

    it('uses same retry config as sync-contact', async () => {
      await service.enqueueDealSync(
        'c-1',
        'x@y.com',
        'product_inquiry',
        'X',
        'Y',
      );

      const opts = queue.add.mock.calls[0][2];
      expect(opts.attempts).toBe(3);
      expect(opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
    });
  });

  describe('enqueueEngagementNote', () => {
    it('adds a log-note job with contact and note payload', async () => {
      const note = {
        subject: 'Hello',
        summary: 'Test email',
        classification: 'product_inquiry',
        sentAt: '2026-07-09T00:00:00Z',
      };
      await service.enqueueEngagementNote('c-1', note);

      expect(queue.add).toHaveBeenCalledTimes(1);
      const [jobName, data] = queue.add.mock.calls[0];
      expect(jobName).toBe(LOG_NOTE_JOB);
      expect(data).toEqual({ contactId: 'c-1', note });
    });

    it('returns immediately (fire-and-forget)', async () => {
      await expect(
        service.enqueueEngagementNote('c-1', {
          subject: 'x',
          summary: 'y',
          classification: 'z',
          sentAt: 'now',
        }),
      ).resolves.toBeUndefined();
    });
  });
});
