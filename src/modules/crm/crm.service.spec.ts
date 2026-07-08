/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Queue } from 'bullmq';
import { CrmService } from './crm.service';
import { SYNC_CONTACT_JOB } from './crm.constants';
import { makeMockClient } from './crm.test-fixtures';

describe('CrmService', () => {
  let queue: { add: jest.Mock };
  let service: CrmService;

  beforeEach(() => {
    queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    service = new CrmService(queue as unknown as Queue);
  });

  it('enqueueContactSync adds a sync-contact job carrying the client', async () => {
    const client = makeMockClient();
    await service.enqueueContactSync(client);

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [jobName, data] = queue.add.mock.calls[0];
    expect(jobName).toBe(SYNC_CONTACT_JOB);
    expect(data).toEqual({ client });
  });

  it('configures 3 attempts with exponential backoff and keeps failed jobs', async () => {
    await service.enqueueContactSync(makeMockClient());

    const opts = queue.add.mock.calls[0][2];
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
    expect(opts.removeOnFail).toBe(false);
  });

  it('returns immediately (fire-and-forget) without awaiting any CRM call', async () => {
    await expect(
      service.enqueueContactSync(makeMockClient()),
    ).resolves.toBeUndefined();
  });
});
