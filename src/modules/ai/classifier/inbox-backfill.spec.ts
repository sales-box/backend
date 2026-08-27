/* eslint-disable @typescript-eslint/unbound-method */
import { Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { GmailProvider } from '../../email/gmail/gmail-provider.service';
import { ClassifierProcessor } from './classifier.processor';
import { ClassifierService } from './classifier.service';
import { ClientsService } from '../../clients/clients.service';
import { InboxBackfillListener } from './inbox-backfill.listener';
import { BACKFILL_INBOX_JOB } from './classifier.constants';
import { BackfillInboxJobData } from './classifier.types';

const ACCOUNT = {
  id: 'acct-1',
  email: 'se@acme.com',
  tenantId: 'tenant-1',
  status: 'connected',
};
const CLASSIFICATION = {
  reasoning: 'r',
  isUrgent: false,
  urgencyReason: null,
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
    connectedAccount: {
      findFirst: jest.fn().mockResolvedValue(ACCOUNT),
      findUnique: jest
        .fn()
        .mockResolvedValue({ isAdmin: false, tenantId: 'tenant-1' }),
    },
    webhookSubscription: {
      findUnique: jest.fn(),
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

function makeGmail(backlogIds: string[]) {
  return {
    listLabelledMessageIds: jest.fn().mockResolvedValue(backlogIds),
    fetchMessage: jest.fn().mockResolvedValue(PARSED),
    fetchNewMessageIds: jest.fn(),
    fetchNewSentThreadIds: jest.fn(),
    getLabelIdByName: jest.fn().mockResolvedValue('Label_salesbox_123'),
    getSalesboxLabelIds: jest.fn().mockResolvedValue(['Label_salesbox_123']),
  } as unknown as GmailProvider;
}

const makeClassifier = () =>
  ({
    classify: jest.fn().mockResolvedValue(CLASSIFICATION),
  }) as unknown as ClassifierService;

const makeClients = () =>
  ({
    captureInboundEmail: jest.fn().mockResolvedValue({}),
  }) as unknown as ClientsService;

const backfillJob = (emailAddress: string) =>
  ({
    id: 'job-b',
    name: BACKFILL_INBOX_JOB,
    data: { emailAddress } satisfies BackfillInboxJobData,
  }) as unknown as Job<BackfillInboxJobData>;

describe('inbox backfill — processor', () => {
  it('classifies the mail already in the mailbox', async () => {
    const prisma = makePrisma();
    const gmail = makeGmail(['m1', 'm2', 'm3']);
    const processor = new ClassifierProcessor(
      prisma,
      gmail,
      makeClassifier(),
      makeClients(),
    );

    const result = await processor.process(backfillJob('se@acme.com'));

    expect(result.classified).toBe(3);
    expect(gmail.fetchMessage).toHaveBeenCalledTimes(3);
  });

  // The live path and a connect-triggered backfill run against one mailbox at
  // the same time. Moving the cursor from here could step the live diff over
  // messages it had not read.
  it('never touches the watch baseline', async () => {
    const prisma = makePrisma();
    const processor = new ClassifierProcessor(
      prisma,
      makeGmail(['m1']),
      makeClassifier(),
      makeClients(),
    );

    await processor.process(backfillJob('se@acme.com'));

    expect(prisma.webhookSubscription.update).not.toHaveBeenCalled();
    expect(prisma.webhookSubscription.findUnique).not.toHaveBeenCalled();
  });

  // Already-stored rows are the exactly-once guard shared with the live path;
  // a backfill overlapping a notification must not double-classify.
  it('skips messages that already have an analysis row', async () => {
    const prisma = makePrisma({
      generalAnalysis: {
        findUnique: jest.fn().mockResolvedValue({ id: 'existing' }),
        create: jest.fn(),
      },
    });
    const gmail = makeGmail(['m1', 'm2']);
    const processor = new ClassifierProcessor(
      prisma,
      gmail,
      makeClassifier(),
      makeClients(),
    );

    const result = await processor.process(backfillJob('se@acme.com'));

    expect(result.classified).toBe(0);
    expect(gmail.fetchMessage).not.toHaveBeenCalled();
  });

  // Unattended work: one unreadable message must not cost the customer the rest.
  it('steps over a failing message and keeps going', async () => {
    const gmail = makeGmail(['bad', 'good']);
    jest
      .mocked(gmail.fetchMessage)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(PARSED);
    const processor = new ClassifierProcessor(
      makePrisma(),
      gmail,
      makeClassifier(),
      makeClients(),
    );

    const result = await processor.process(backfillJob('se@acme.com'));

    expect(result.classified).toBe(1);
  });

  // Continuing past a 429 just burns the remaining quota against a wall.
  it('stops early on a rate limit instead of draining the quota', async () => {
    const gmail = makeGmail(['m1', 'm2', 'm3', 'm4']);
    jest
      .mocked(gmail.fetchMessage)
      .mockResolvedValueOnce(PARSED)
      .mockRejectedValue(new Error('LLM Generation Error: 429 status code'));
    const processor = new ClassifierProcessor(
      makePrisma(),
      gmail,
      makeClassifier(),
      makeClients(),
    );

    const result = await processor.process(backfillJob('se@acme.com'));

    expect(result.classified).toBe(1);
    // 1 success + 1 that hit the limit; the remaining two are never attempted.
    expect(gmail.fetchMessage).toHaveBeenCalledTimes(2);
  });

  it('reports a disconnected account rather than throwing', async () => {
    const prisma = makePrisma({
      connectedAccount: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    const processor = new ClassifierProcessor(
      prisma,
      makeGmail([]),
      makeClassifier(),
      makeClients(),
    );

    await expect(
      processor.process(backfillJob('nobody@acme.com')),
    ).resolves.toEqual({ skipped: 'no_account', classified: 0 });
  });
});

describe('inbox backfill — listener', () => {
  const queue = () => ({ add: jest.fn().mockResolvedValue({}) });

  it('queues a backfill when a mailbox is connected', async () => {
    const q = queue();
    const listener = new InboxBackfillListener(makePrisma(), q as never);

    await listener.handleGoogleAccountConnected({
      id: 'acct-1',
      email: 'se@acme.com',
    });

    expect(q.add).toHaveBeenCalledWith(
      BACKFILL_INBOX_JOB,
      { emailAddress: 'se@acme.com' },
      expect.objectContaining({ jobId: 'backfill#se@acme.com' }),
    );
  });

  // Connecting twice, or a duplicated event, must not re-walk 500 messages.
  it('uses a stable job id so repeats collapse into one', async () => {
    const q = queue();
    const listener = new InboxBackfillListener(makePrisma(), q as never);

    await listener.handleGoogleAccountConnected({
      id: 'acct-1',
      email: 'se@acme.com',
    });
    await listener.handleGoogleAccountConnected({
      id: 'acct-1',
      email: 'se@acme.com',
    });

    const ids = q.add.mock.calls.map(
      (c: unknown[]) => (c[2] as { jobId: string }).jobId,
    );
    expect(new Set(ids).size).toBe(1);
  });

  it('ignores an admin account', async () => {
    const q = queue();
    const prisma = makePrisma({
      connectedAccount: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ isAdmin: true, tenantId: 'tenant-1' }),
      },
    });
    const listener = new InboxBackfillListener(prisma, q as never);

    await listener.handleGoogleAccountConnected({
      id: 'a',
      email: 'admin@acme.com',
    });

    expect(q.add).not.toHaveBeenCalled();
  });

  // Admin-first-connect links the tenant later and re-fires the event.
  it('waits for a tenant rather than queueing work that cannot authenticate', async () => {
    const q = queue();
    const prisma = makePrisma({
      connectedAccount: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ isAdmin: false, tenantId: null }),
      },
    });
    const listener = new InboxBackfillListener(prisma, q as never);

    await listener.handleGoogleAccountConnected({
      id: 'a',
      email: 'se@acme.com',
    });

    expect(q.add).not.toHaveBeenCalled();
  });
});
