/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method */
import { Job } from 'bullmq';
import { CrmProcessor } from './crm.processor';
import { ICrmAdapter } from './crm.interface';
import { makeMockClient } from './crm.test-fixtures';

function makeJob(client = makeMockClient()): Job {
  return {
    id: 'job-1',
    attemptsMade: 0,
    data: { client },
  } as unknown as Job;
}

describe('CrmProcessor', () => {
  it('delegates to the adapter and returns the resulting contactId', async () => {
    const adapter: ICrmAdapter = {
      syncContact: jest.fn().mockResolvedValue('contact-42'),
      logNote: jest.fn(),
    };
    const processor = new CrmProcessor(adapter);

    const client = makeMockClient();
    const result = await processor.process(makeJob(client));

    expect(adapter.syncContact).toHaveBeenCalledWith(client);
    expect(result).toEqual({ contactId: 'contact-42' });
  });

  it('lets adapter errors propagate so BullMQ retries the job', async () => {
    const adapter: ICrmAdapter = {
      syncContact: jest.fn().mockRejectedValue(new Error('CRM down')),
      logNote: jest.fn(),
    };
    const processor = new CrmProcessor(adapter);

    await expect(processor.process(makeJob())).rejects.toThrow('CRM down');
  });
});
