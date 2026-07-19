/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { GmailProvider } from '../../email/gmail/gmail-provider.service';
import { ClassifierProcessor } from './classifier.processor';
import { ClassifierService } from './classifier.service';
import { ClassifyEmailJobData } from './classifier.types';

const ACCOUNT = {
  id: 'acct-1',
  email: 'se@acme.com',
  tenantId: 'tenant-1',
  status: 'connected',
};
const SUBSCRIPTION = { connectedAccountId: 'acct-1', lastHistoryId: '100' };
const CLASSIFICATION = {
  reasoning: 'r',
  isUrgent: true,
  urgencyReason: 'deadline',
  intent: 'product inquiry',
  intentConfidence: 0.9,
};
const PARSED = {
  id: 'm1',
  threadId: 't1',
  subject: 's',
  from: 'client@x.com',
  to: 'se@acme.com',
  date: '',
  textPlain: 'need pricing',
  textHtml: '',
  attachments: [],
};

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    connectedAccount: { findFirst: jest.fn().mockResolvedValue(ACCOUNT) },
    webhookSubscription: {
      findUnique: jest.fn().mockResolvedValue(SUBSCRIPTION),
      update: jest.fn().mockResolvedValue({}),
    },
    generalAnalysis: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  } as unknown as PrismaService;
}

function makeGmail(ids: string[] = ['m1'], newHistoryId = '200') {
  return {
    fetchNewMessageIds: jest
      .fn()
      .mockResolvedValue({ messageIds: ids, newHistoryId }),
    fetchMessage: jest.fn().mockResolvedValue(PARSED),
    fetchNewSentThreadIds: jest
      .fn()
      .mockResolvedValue({ threadIds: [], newHistoryId }),
  } as unknown as GmailProvider;
}

function makeClassifier() {
  return {
    classify: jest.fn().mockResolvedValue(CLASSIFICATION),
  } as unknown as ClassifierService;
}

function makeJob(data: ClassifyEmailJobData): Job<ClassifyEmailJobData> {
  return {
    id: 'job-1',
    name: 'classify-email',
    data,
  } as unknown as Job<ClassifyEmailJobData>;
}

describe('ClassifierProcessor', () => {
  const jobData = { emailAddress: 'se@acme.com', historyId: '150' };

  it('classifies each new message and stores a general analysis row', async () => {
    const prisma = makePrisma();
    const gmail = makeGmail(['m1']);
    const classifier = makeClassifier();
    const processor = new ClassifierProcessor(prisma, gmail, classifier);

    const result = await processor.process(makeJob(jobData));

    expect(gmail.fetchNewMessageIds).toHaveBeenCalledWith('se@acme.com', '100');
    // Subject is prepended to the body before classification.
    expect(classifier.classify).toHaveBeenCalledWith(
      'Subject: s\n\nneed pricing',
    );
    expect(prisma.generalAnalysis.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        messageId: 'm1',
        tenantId: 'tenant-1',
        isUrgent: true,
        intent: 'product inquiry',
        intentConfidence: 0.9,
      }),
    });
    expect(prisma.webhookSubscription.update).toHaveBeenCalledWith({
      where: { connectedAccountId: 'acct-1' },
      data: { lastHistoryId: '200' },
    });
    expect(result).toEqual({ classified: 1 });
  });

  it('is idempotent: an already-analyzed message is never re-classified', async () => {
    const prisma = makePrisma({
      generalAnalysis: {
        findUnique: jest.fn().mockResolvedValue({ id: 'existing' }),
        create: jest.fn(),
      },
    });
    const gmail = makeGmail(['m1']);
    const classifier = makeClassifier();
    const processor = new ClassifierProcessor(prisma, gmail, classifier);

    const result = await processor.process(makeJob(jobData));

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(prisma.generalAnalysis.create).not.toHaveBeenCalled();
    expect(result).toEqual({ classified: 0 });
  });

  it('skips unknown accounts without touching Gmail', async () => {
    const prisma = makePrisma({
      connectedAccount: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    const gmail = makeGmail();
    const processor = new ClassifierProcessor(prisma, gmail, makeClassifier());

    const result = await processor.process(makeJob(jobData));

    expect(result).toEqual({ skipped: 'no_account', classified: 0 });
    expect(gmail.fetchNewMessageIds).not.toHaveBeenCalled();
  });

  it('seeds the baseline and skips when none is stored yet', async () => {
    const prisma = makePrisma({
      webhookSubscription: {
        findUnique: jest.fn().mockResolvedValue({
          connectedAccountId: 'acct-1',
          lastHistoryId: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    const gmail = makeGmail();
    const processor = new ClassifierProcessor(prisma, gmail, makeClassifier());

    const result = await processor.process(makeJob(jobData));

    expect(prisma.webhookSubscription.update).toHaveBeenCalledWith({
      where: { connectedAccountId: 'acct-1' },
      data: { lastHistoryId: '150' },
    });
    expect(result).toEqual({ skipped: 'no_baseline', classified: 0 });
    expect(gmail.fetchNewMessageIds).not.toHaveBeenCalled();
  });

  it('resets the baseline when Gmail reports the history window expired (404)', async () => {
    const prisma = makePrisma();
    const gmail = {
      fetchNewMessageIds: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Not Found'), { code: 404 }),
        ),
      fetchMessage: jest.fn(),
      fetchNewSentThreadIds: jest
        .fn()
        .mockResolvedValue({ threadIds: [], newHistoryId: '150' }),
    } as unknown as GmailProvider;
    const processor = new ClassifierProcessor(prisma, gmail, makeClassifier());

    const result = await processor.process(makeJob(jobData));

    expect(prisma.webhookSubscription.update).toHaveBeenCalledWith({
      where: { connectedAccountId: 'acct-1' },
      data: { lastHistoryId: '150' },
    });
    expect(result).toEqual({ skipped: 'history_expired', classified: 0 });
  });

  it('throws when any message fails (BullMQ retries) and does NOT advance the baseline', async () => {
    const prisma = makePrisma();
    const gmail = makeGmail(['m1', 'm2']);
    const classifier = {
      classify: jest
        .fn()
        .mockResolvedValueOnce(CLASSIFICATION)
        .mockRejectedValueOnce(new Error('LLM down')),
    } as unknown as ClassifierService;
    const processor = new ClassifierProcessor(prisma, gmail, classifier);

    await expect(processor.process(makeJob(jobData))).rejects.toThrow(
      /failed for 1\/2/,
    );
    expect(prisma.webhookSubscription.update).not.toHaveBeenCalled();
  });

  it('stops the batch on the FIRST provider rate-limit (429) instead of hammering every message', async () => {
    const prisma = makePrisma();
    const gmail = makeGmail(['m1', 'm2', 'm3']);
    // LlmClientService wraps provider errors into a plain Error whose message
    // carries the status text — this mirrors the real shape.
    const classifier = {
      classify: jest
        .fn()
        .mockRejectedValue(
          new Error('LLM Generation Error: 429 status code (no body)'),
        ),
    } as unknown as ClassifierService;
    const processor = new ClassifierProcessor(prisma, gmail, classifier);

    await expect(processor.process(makeJob(jobData))).rejects.toThrow(
      /rate.?limit/i,
    );
    // ONE probe, not one 429 per message in the batch.
    expect(classifier.classify).toHaveBeenCalledTimes(1);
    expect(prisma.webhookSubscription.update).not.toHaveBeenCalled();
  });

  it('keeps partial progress when the rate-limit hits mid-batch (stored rows survive for the retry)', async () => {
    const prisma = makePrisma();
    const gmail = makeGmail(['m1', 'm2', 'm3']);
    const classifier = {
      classify: jest
        .fn()
        .mockResolvedValueOnce(CLASSIFICATION)
        .mockRejectedValueOnce(
          new Error('LLM Generation Error: 429 status code (no body)'),
        ),
    } as unknown as ClassifierService;
    const processor = new ClassifierProcessor(prisma, gmail, classifier);

    await expect(processor.process(makeJob(jobData))).rejects.toThrow(
      /rate.?limit/i,
    );
    // m1 stored before the 429 — the BullMQ retry will skip it via the
    // messageId-unique dedup and resume from m2.
    expect(prisma.generalAnalysis.create).toHaveBeenCalledTimes(1);
    expect(classifier.classify).toHaveBeenCalledTimes(2);
    expect(prisma.webhookSubscription.update).not.toHaveBeenCalled();
  });

  it('skips messages with no classifiable text AND still advances the baseline', async () => {
    const prisma = makePrisma();
    const gmail = {
      fetchNewMessageIds: jest
        .fn()
        .mockResolvedValue({ messageIds: ['m1'], newHistoryId: '200' }),
      // empty subject + quote-only body => nothing to classify
      fetchMessage: jest.fn().mockResolvedValue({
        ...PARSED,
        subject: '',
        textPlain: '> quoted only',
        textHtml: '',
      }),
      fetchNewSentThreadIds: jest
        .fn()
        .mockResolvedValue({ threadIds: [], newHistoryId: '200' }),
    } as unknown as GmailProvider;
    const classifier = makeClassifier();
    const processor = new ClassifierProcessor(prisma, gmail, classifier);

    const result = await processor.process(makeJob(jobData));

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(prisma.generalAnalysis.create).not.toHaveBeenCalled();
    // The load-bearing property: an unclassifiable message must NOT be
    // re-fetched forever — the baseline still moves past it.
    expect(prisma.webhookSubscription.update).toHaveBeenCalledWith({
      where: { connectedAccountId: 'acct-1' },
      data: { lastHistoryId: '200' },
    });
    expect(result).toEqual({ classified: 0 });
  });

  it('classifies a subject-only email (empty body) instead of skipping it', async () => {
    const prisma = makePrisma();
    const gmail = {
      fetchNewMessageIds: jest
        .fn()
        .mockResolvedValue({ messageIds: ['m1'], newHistoryId: '200' }),
      fetchMessage: jest.fn().mockResolvedValue({
        ...PARSED,
        subject: 'URGENT: production is down',
        textPlain: '',
        textHtml: '',
      }),
      fetchNewSentThreadIds: jest
        .fn()
        .mockResolvedValue({ threadIds: [], newHistoryId: '200' }),
    } as unknown as GmailProvider;
    const classifier = makeClassifier();
    const processor = new ClassifierProcessor(prisma, gmail, classifier);

    const result = await processor.process(makeJob(jobData));

    expect(classifier.classify).toHaveBeenCalledWith(
      'Subject: URGENT: production is down',
    );
    expect(result).toEqual({ classified: 1 });
  });

  it('skips a message that is gone (404 on fetch) without failing the batch, and advances the baseline', async () => {
    const prisma = makePrisma();
    const gmail = {
      fetchNewMessageIds: jest
        .fn()
        .mockResolvedValue({ messageIds: ['gone', 'm2'], newHistoryId: '200' }),
      fetchMessage: jest
        .fn()
        .mockImplementationOnce(() =>
          Promise.reject(Object.assign(new Error('Not Found'), { code: 404 })),
        )
        .mockResolvedValueOnce(PARSED),
      fetchNewSentThreadIds: jest
        .fn()
        .mockResolvedValue({ threadIds: [], newHistoryId: '200' }),
    } as unknown as GmailProvider;
    const classifier = makeClassifier();
    const processor = new ClassifierProcessor(prisma, gmail, classifier);

    const result = await processor.process(makeJob(jobData));

    // The gone message is skipped, the good one is classified, baseline moves.
    expect(result).toEqual({ classified: 1 });
    expect(prisma.webhookSubscription.update).toHaveBeenCalledWith({
      where: { connectedAccountId: 'acct-1' },
      data: { lastHistoryId: '200' },
    });
  });

  it('propagates a NON-gone fetch error (transient) so BullMQ retries and the baseline is NOT advanced', async () => {
    const prisma = makePrisma();
    const gmail = {
      fetchNewMessageIds: jest
        .fn()
        .mockResolvedValue({ messageIds: ['m1'], newHistoryId: '200' }),
      fetchMessage: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('backend error'), { code: 500 }),
        ),
      fetchNewSentThreadIds: jest
        .fn()
        .mockResolvedValue({ threadIds: [], newHistoryId: '200' }),
    } as unknown as GmailProvider;
    const processor = new ClassifierProcessor(prisma, gmail, makeClassifier());

    await expect(processor.process(makeJob(jobData))).rejects.toThrow(
      /failed for 1\/1/,
    );
    expect(prisma.webhookSubscription.update).not.toHaveBeenCalled();
  });

  it('treats a concurrent-write P2002 as already-done (skip) and still advances the baseline', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
    });
    const prisma = makePrisma({
      generalAnalysis: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(p2002),
      },
    });
    const gmail = makeGmail(['m1']);
    const processor = new ClassifierProcessor(prisma, gmail, makeClassifier());

    const result = await processor.process(makeJob(jobData));

    expect(result).toEqual({ classified: 0 });
    expect(prisma.webhookSubscription.update).toHaveBeenCalledWith({
      where: { connectedAccountId: 'acct-1' },
      data: { lastHistoryId: '200' },
    });
  });

  it('rethrows a non-P2002 create error (transient) and does NOT advance the baseline', async () => {
    const prisma = makePrisma({
      generalAnalysis: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(new Error('db down')),
      },
    });
    const gmail = makeGmail(['m1']);
    const processor = new ClassifierProcessor(prisma, gmail, makeClassifier());

    await expect(processor.process(makeJob(jobData))).rejects.toThrow();
    expect(prisma.webhookSubscription.update).not.toHaveBeenCalled();
  });

  it('marks corresponding general analysis rows as reviewed when thread replies are detected on the SENT label', async () => {
    const prisma = makePrisma({
      generalAnalysis: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });

    const gmail = {
      fetchNewMessageIds: jest
        .fn()
        .mockResolvedValue({ messageIds: ['m1'], newHistoryId: '200' }),
      fetchMessage: jest.fn().mockResolvedValue(PARSED),
      fetchNewSentThreadIds: jest
        .fn()
        .mockResolvedValue({ threadIds: ['t_sent'], newHistoryId: '250' }),
    } as unknown as GmailProvider;

    const classifier = makeClassifier();
    const processor = new ClassifierProcessor(prisma, gmail, classifier);

    await processor.process(makeJob(jobData));

    expect(gmail.fetchNewSentThreadIds).toHaveBeenCalledWith(
      'se@acme.com',
      '100',
    );
    expect(prisma.generalAnalysis.updateMany).toHaveBeenCalledWith({
      where: {
        threadId: { in: ['t_sent'] },
        accountEmail: 'se@acme.com',
        tenantId: 'tenant-1',
        reviewedAt: null,
      },
      data: { reviewedAt: expect.any(Date) },
    });

    expect(prisma.webhookSubscription.update).toHaveBeenCalledWith({
      where: { connectedAccountId: 'acct-1' },
      data: { lastHistoryId: '250' },
    });
  });
});
