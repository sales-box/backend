/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { GmailProvider } from '../../email/gmail/gmail-provider.service';
import { CLASSIFY_EMAIL_JOB } from './classifier.constants';
import { ClassifierProcessor } from './classifier.processor';
import { ClassifierService } from './classifier.service';
import { ClassifyEmailJobData } from './classifier.types';
import { MessageClassifier } from './message-classifier.service';
import { ClientsService } from '../../clients/clients.service';

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
  isComplaint: false,
  complaintAbout: 'none',
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
  labelIds: ['Label_salesbox_123'],
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
      create: jest.fn().mockResolvedValue({ id: 'analysis-1' }),
    },
    escalationItem: {
      upsert: jest.fn().mockResolvedValue({}),
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
    getLabelIdByName: jest.fn().mockResolvedValue('Label_salesbox_123'),
    getSalesboxLabelIds: jest.fn().mockResolvedValue(['Label_salesbox_123']),
  } as unknown as GmailProvider;
}

function makeClassifier() {
  return {
    classify: jest.fn().mockResolvedValue(CLASSIFICATION),
  } as unknown as ClassifierService;
}

function makeClients() {
  return {
    captureInboundEmail: jest.fn().mockResolvedValue({}),
  } as unknown as ClientsService;
}

function makeJob(data: ClassifyEmailJobData): Job<ClassifyEmailJobData> {
  return {
    id: 'job-1',
    name: CLASSIFY_EMAIL_JOB,
    data,
  } as unknown as Job<ClassifyEmailJobData>;
}

/** The processor delegates the per-message work; wire the real collaborator. */
function makeProcessor(
  prisma: PrismaService,
  gmail: GmailProvider,
  classifier: ClassifierService,
  clients: ClientsService,
) {
  return new ClassifierProcessor(
    prisma,
    gmail,
    new MessageClassifier(prisma, gmail, classifier, clients),
  );
}

describe('ClassifierProcessor', () => {
  const jobData = { emailAddress: 'se@acme.com', historyId: '150' };

  // The worker used to treat "not the backfill job" as "a live notification"
  // and read historyId off whatever arrived. A payload that has none would
  // then re-anchor the baseline from `undefined`.
  it('rejects a job name it does not know instead of guessing', async () => {
    const prisma = makePrisma();
    const gmail = makeGmail(['m1']);
    const processor = makeProcessor(
      prisma,
      gmail,
      makeClassifier(),
      makeClients(),
    );
    const job = {
      id: 'job-x',
      name: 'something-else',
      data: jobData,
    } as unknown as Job<ClassifyEmailJobData>;

    await expect(processor.process(job)).rejects.toThrow(/unknown job/i);
    expect(gmail.fetchNewMessageIds).not.toHaveBeenCalled();
    expect(prisma.webhookSubscription.update).not.toHaveBeenCalled();
  });

  it('classifies each new message and stores a general analysis row', async () => {
    const prisma = makePrisma();
    const gmail = makeGmail(['m1']);
    const classifier = makeClassifier();
    const clients = makeClients();
    jest.mocked(classifier.classify).mockImplementation(() => {
      expect(clients.captureInboundEmail).toHaveBeenCalledTimes(1);
      return Promise.resolve(CLASSIFICATION);
    });
    const processor = makeProcessor(prisma, gmail, classifier, clients);

    const result = await processor.process(makeJob(jobData));

    expect(gmail.fetchNewMessageIds).toHaveBeenCalledWith(
      'tenant-1',
      'se@acme.com',
      '100',
    );
    // Subject is prepended to the body before classification.
    expect(classifier.classify).toHaveBeenCalledWith(
      'Subject: s\n\nneed pricing',
    );
    expect(clients.captureInboundEmail).toHaveBeenNthCalledWith(
      1,
      'tenant-1',
      expect.objectContaining({
        messageId: 'm1',
        senderEmail: 'client@x.com',
        subject: 's',
      }),
    );
    expect(clients.captureInboundEmail).toHaveBeenNthCalledWith(
      2,
      'tenant-1',
      expect.objectContaining({
        aiSummary: 'r',
        classification: 'product inquiry',
      }),
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

  it('keeps the inbound capture when classification fails', async () => {
    const prisma = makePrisma();
    const gmail = makeGmail(['m1']);
    const classifier = {
      classify: jest.fn().mockRejectedValue(new Error('LLM down')),
    } as unknown as ClassifierService;
    const clients = makeClients();
    const processor = makeProcessor(prisma, gmail, classifier, clients);

    await expect(processor.process(makeJob(jobData))).rejects.toThrow(
      /failed for 1\/1/,
    );
    expect(clients.captureInboundEmail).toHaveBeenCalledTimes(1);
    expect(clients.captureInboundEmail).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ messageId: 'm1' }),
    );
  });

  it('classifies an invalid sender without capture or retry poisoning', async () => {
    const prisma = makePrisma();
    const gmail = makeGmail(['m1']);
    (gmail.fetchMessage as jest.Mock).mockResolvedValue({
      ...PARSED,
      from: 'undisclosed recipients',
    });
    const classifier = makeClassifier();
    const clients = makeClients();
    const processor = makeProcessor(prisma, gmail, classifier, clients);

    const result = await processor.process(makeJob(jobData));

    expect(classifier.classify).toHaveBeenCalledTimes(1);
    expect(clients.captureInboundEmail).not.toHaveBeenCalled();
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
    const processor = makeProcessor(prisma, gmail, classifier, makeClients());

    const result = await processor.process(makeJob(jobData));

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(prisma.generalAnalysis.create).not.toHaveBeenCalled();
    expect(result).toEqual({ classified: 0 });
  });

  it('skips messages that do not carry the salesbox label', async () => {
    const prisma = makePrisma();
    const gmail = makeGmail(['m1']);
    (gmail.fetchMessage as jest.Mock).mockResolvedValue({
      ...PARSED,
      labelIds: ['INBOX'], // missing Label_salesbox_123
    });
    const classifier = makeClassifier();
    const processor = makeProcessor(prisma, gmail, classifier, makeClients());

    const result = await processor.process(makeJob(jobData));

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(result).toEqual({ classified: 0 });
  });

  it('skips unknown accounts without touching Gmail', async () => {
    const prisma = makePrisma({
      connectedAccount: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    const gmail = makeGmail();
    const processor = makeProcessor(
      prisma,
      gmail,
      makeClassifier(),
      makeClients(),
    );

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
    const processor = makeProcessor(
      prisma,
      gmail,
      makeClassifier(),
      makeClients(),
    );

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
    const processor = makeProcessor(
      prisma,
      gmail,
      makeClassifier(),
      makeClients(),
    );

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
    const processor = makeProcessor(prisma, gmail, classifier, makeClients());

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
    const processor = makeProcessor(prisma, gmail, classifier, makeClients());

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
    const processor = makeProcessor(prisma, gmail, classifier, makeClients());

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
      getLabelIdByName: jest.fn().mockResolvedValue('Label_salesbox_123'),
      getSalesboxLabelIds: jest.fn().mockResolvedValue(['Label_salesbox_123']),
    } as unknown as GmailProvider;
    const classifier = makeClassifier();
    const processor = makeProcessor(prisma, gmail, classifier, makeClients());

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
      getLabelIdByName: jest.fn().mockResolvedValue('Label_salesbox_123'),
      getSalesboxLabelIds: jest.fn().mockResolvedValue(['Label_salesbox_123']),
    } as unknown as GmailProvider;
    const classifier = makeClassifier();
    const processor = makeProcessor(prisma, gmail, classifier, makeClients());

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
      getLabelIdByName: jest.fn().mockResolvedValue('Label_salesbox_123'),
      getSalesboxLabelIds: jest.fn().mockResolvedValue(['Label_salesbox_123']),
    } as unknown as GmailProvider;
    const classifier = makeClassifier();
    const processor = makeProcessor(prisma, gmail, classifier, makeClients());

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
      getLabelIdByName: jest.fn().mockResolvedValue('Label_salesbox_123'),
      getSalesboxLabelIds: jest.fn().mockResolvedValue(['Label_salesbox_123']),
    } as unknown as GmailProvider;
    const processor = makeProcessor(
      prisma,
      gmail,
      makeClassifier(),
      makeClients(),
    );

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
    const processor = makeProcessor(
      prisma,
      gmail,
      makeClassifier(),
      makeClients(),
    );

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
    const processor = makeProcessor(
      prisma,
      gmail,
      makeClassifier(),
      makeClients(),
    );

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
      getLabelIdByName: jest.fn().mockResolvedValue('Label_salesbox_123'),
      getSalesboxLabelIds: jest.fn().mockResolvedValue(['Label_salesbox_123']),
    } as unknown as GmailProvider;

    const classifier = makeClassifier();
    const processor = makeProcessor(prisma, gmail, classifier, makeClients());

    await processor.process(makeJob(jobData));

    expect(gmail.fetchNewSentThreadIds).toHaveBeenCalledWith(
      'tenant-1',
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

  describe('complaint escalation', () => {
    /** Runs one message through the processor with a given classification. */
    const run = async (over: Record<string, unknown>) => {
      const prisma = makePrisma();
      const classifier = {
        classify: jest.fn().mockResolvedValue({ ...CLASSIFICATION, ...over }),
      } as unknown as ClassifierService;
      const processor = makeProcessor(
        prisma,
        makeGmail(),
        classifier,
        makeClients(),
      );
      await processor.process(makeJob(jobData));
      return prisma as unknown as {
        generalAnalysis: { create: jest.Mock };
        escalationItem: { upsert: jest.Mock };
      };
    };

    const escalation = (p: { escalationItem: { upsert: jest.Mock } }) =>
      (p.escalationItem.upsert.mock.calls as unknown[][])[0]?.[0] as
        { create: { severity: string } } | undefined;

    it('persists the complaint fields on the analysis row', async () => {
      const prisma = await run({ isComplaint: true, complaintAbout: 'person' });
      const created = (
        prisma.generalAnalysis.create.mock.calls as unknown[][]
      )[0][0] as { data: Record<string, unknown> };
      expect(created.data).toMatchObject({
        isComplaint: true,
        complaintAbout: 'person',
      });
    });

    it('escalates a complaint about a person at HIGH, urgent or not', async () => {
      // The case the whole feature exists for. Routed only to the SE's inbox,
      // the person being complained about decides whether anyone hears it — so
      // it must reach the admin on its own, and near the top of the feed.
      const prisma = await run({
        isUrgent: false,
        urgencyReason: null,
        intent: 'support',
        isComplaint: true,
        complaintAbout: 'person',
      });
      expect(escalation(prisma)?.create.severity).toBe('high');
    });

    it('escalates a complaint about the company', async () => {
      const prisma = await run({
        isUrgent: false,
        urgencyReason: null,
        intent: 'support',
        isComplaint: true,
        complaintAbout: 'service',
      });
      expect(escalation(prisma)).toBeDefined();
    });

    it('does NOT escalate a plain product complaint', async () => {
      // A broken product is a support ticket. It belongs with the SE on the
      // account, and there is no conflict of interest to work around.
      const prisma = await run({
        isUrgent: false,
        urgencyReason: null,
        intent: 'support',
        isComplaint: true,
        complaintAbout: 'product',
      });
      expect(prisma.escalationItem.upsert).not.toHaveBeenCalled();
    });

    it('does NOT escalate a calm non-complaint', async () => {
      const prisma = await run({
        isUrgent: false,
        urgencyReason: null,
        intent: 'follow-up',
      });
      expect(prisma.escalationItem.upsert).not.toHaveBeenCalled();
    });
  });
});
