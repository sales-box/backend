/* eslint-disable @typescript-eslint/unbound-method */
import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { ParsedMessage } from '../../email/email.types';
import { GmailClientFactory } from '../../email/gmail/gmail-client.factory';
import { GmailProvider } from '../../email/gmail/gmail-provider.service';
import { GmailWebhookService } from '../../email/gmail/webhook/gmail-webhook.service';
import {
  BACKFILL_INBOX_JOB,
  BACKFILL_MAX_MESSAGES,
  BACKFILL_NEWER_THAN_DAYS,
  BACKFILL_QUEUE,
  positiveIntFromEnv,
} from './classifier.constants';
import { ClassifierService } from './classifier.service';
import { BackfillInboxJobData } from './classifier.types';
import { InboxBackfillListener } from './inbox-backfill.listener';
import { InboxBackfillProcessor } from './inbox-backfill.processor';
import { MessageClassifier } from './message-classifier.service';
import { ClientsService } from '../../clients/clients.service';

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
const PARSED: ParsedMessage = {
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
      upsert: jest.fn().mockResolvedValue({}),
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

/**
 * fetchMessage answers with the id it was ASKED for. A mock that returns the
 * same message whatever it is handed proves the loop ran N times and nothing
 * about which ids reached it — the mistake this shape exists to prevent.
 */
function makeGmail(backlogIds: string[]) {
  return {
    listLabelledMessageIds: jest.fn().mockResolvedValue(backlogIds),
    fetchMessage: jest.fn((_tenantId: string, messageId: string) =>
      Promise.resolve({ ...PARSED, id: messageId, threadId: `t-${messageId}` }),
    ),
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

const makeProcessor = (prisma: PrismaService, gmail: GmailProvider) =>
  new InboxBackfillProcessor(
    prisma,
    gmail,
    new MessageClassifier(prisma, gmail, makeClassifier(), makeClients()),
  );

const backfillJob = (emailAddress: string) =>
  ({
    id: 'job-b',
    name: BACKFILL_INBOX_JOB,
    data: { emailAddress } satisfies BackfillInboxJobData,
  }) as unknown as Job<BackfillInboxJobData>;

/** Message ids in the order they were actually requested from Gmail. */
const fetchedIds = (gmail: GmailProvider) =>
  jest.mocked(gmail.fetchMessage).mock.calls.map((call) => call[1]);

/** Message ids that ended up on a stored analysis row. */
const storedIds = (prisma: PrismaService) =>
  (
    jest.mocked(prisma.generalAnalysis.create).mock.calls as unknown as Array<
      [{ data: { messageId: string } }]
    >
  ).map(([arg]) => arg.data.messageId);

describe('inbox backfill — processor', () => {
  it('classifies the mail already in the mailbox', async () => {
    const prisma = makePrisma();
    const gmail = makeGmail(['m1', 'm2', 'm3']);
    const processor = makeProcessor(prisma, gmail);

    const result = await processor.process(backfillJob('se@acme.com'));

    expect(result.classified).toBe(3);
    // Every listed id, in order, fetched once and stored once.
    expect(fetchedIds(gmail)).toEqual(['m1', 'm2', 'm3']);
    expect(storedIds(prisma)).toEqual(['m1', 'm2', 'm3']);
  });

  it('lists the backlog under the configured bounds', async () => {
    const prisma = makePrisma();
    const gmail = makeGmail([]);
    const processor = makeProcessor(prisma, gmail);

    await processor.process(backfillJob('se@acme.com'));

    expect(gmail.listLabelledMessageIds).toHaveBeenCalledWith(
      'tenant-1',
      'se@acme.com',
      {
        maxMessages: BACKFILL_MAX_MESSAGES,
        newerThanDays: BACKFILL_NEWER_THAN_DAYS,
      },
    );
  });

  // The live path and a connect-triggered backfill run against one mailbox at
  // the same time. Moving the cursor from here could step the live diff over
  // messages it had not read.
  it('never touches the watch baseline', async () => {
    const prisma = makePrisma();
    const processor = makeProcessor(prisma, makeGmail(['m1']));

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
    const processor = makeProcessor(prisma, gmail);

    const result = await processor.process(backfillJob('se@acme.com'));

    expect(result.classified).toBe(0);
    expect(gmail.fetchMessage).not.toHaveBeenCalled();
  });

  // Unattended work: one unreadable message must not cost the customer the rest.
  it('steps over a failing message and keeps going', async () => {
    const prisma = makePrisma();
    const gmail = makeGmail(['bad', 'good']);
    jest
      .mocked(gmail.fetchMessage)
      .mockImplementation((_tenantId, messageId) =>
        messageId === 'bad'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ ...PARSED, id: messageId }),
      );
    const processor = makeProcessor(prisma, gmail);

    const result = await processor.process(backfillJob('se@acme.com'));

    expect(result.classified).toBe(1);
    // It is the message AFTER the failure that had to survive.
    expect(storedIds(prisma)).toEqual(['good']);
  });

  // Reporting the partial pass as a completed job is how the remainder used to
  // be abandoned: BullMQ has no other signal that there is work left.
  it('fails the job on a rate limit so the remainder is retried', async () => {
    const prisma = makePrisma();
    const gmail = makeGmail(['m1', 'm2', 'm3', 'm4']);
    jest
      .mocked(gmail.fetchMessage)
      .mockImplementationOnce((_tenantId, messageId) =>
        Promise.resolve({ ...PARSED, id: messageId }),
      )
      .mockRejectedValue(new Error('LLM Generation Error: 429 status code'));
    const processor = makeProcessor(prisma, gmail);

    await expect(processor.process(backfillJob('se@acme.com'))).rejects.toThrow(
      /rate.?limit/i,
    );

    // 1 success + 1 that hit the limit; the remaining two are never attempted.
    expect(fetchedIds(gmail)).toEqual(['m1', 'm2']);
    // The work done before the 429 is committed — the retry skips it via the
    // stored-row check and resumes at m2.
    expect(storedIds(prisma)).toEqual(['m1']);
  });

  it('reports a disconnected account rather than throwing', async () => {
    const prisma = makePrisma({
      connectedAccount: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    const processor = makeProcessor(prisma, makeGmail([]));

    await expect(
      processor.process(backfillJob('nobody@acme.com')),
    ).resolves.toEqual({ skipped: 'no_account', classified: 0 });
  });

  it('rejects a job name it does not know', async () => {
    const gmail = makeGmail(['m1']);
    const processor = makeProcessor(makePrisma(), gmail);
    const job = {
      id: 'job-x',
      name: 'classify-email',
      data: { emailAddress: 'se@acme.com' },
    } as unknown as Job<BackfillInboxJobData>;

    await expect(processor.process(job)).rejects.toThrow(/unknown job/i);
    expect(gmail.listLabelledMessageIds).not.toHaveBeenCalled();
  });
});

describe('inbox backfill — listener', () => {
  /**
   * Models the one BullMQ property this listener leans on: an `add` carrying a
   * jobId that is already present is a no-op, not a second job. Asserting on
   * `add` call arguments alone cannot see that — it passes even if two jobs are
   * created.
   */
  const queue = () => {
    const jobs = new Map<string, unknown>();
    const add = jest.fn(
      (
        name: string,
        data: unknown,
        opts: {
          jobId: string;
          attempts?: number;
          backoff?: { type: string; delay: number };
        },
      ) => {
        if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, { name, data, opts });
        return Promise.resolve(jobs.get(opts.jobId));
      },
    );
    return { add, jobs };
  };

  it('queues a backfill once the watch is established', async () => {
    const q = queue();
    const listener = new InboxBackfillListener(makePrisma(), q as never);

    await listener.handleWatchEstablished({
      id: 'acct-1',
      email: 'se@acme.com',
    });

    expect(q.add).toHaveBeenCalledWith(
      BACKFILL_INBOX_JOB,
      { emailAddress: 'se@acme.com' },
      expect.objectContaining({ jobId: 'backfill#se@acme.com' }),
    );
  });

  // A 429 fails the job now, so the queue has to be told to come back for it.
  it('gives the job retries spaced wide enough to outlast a rate limit', async () => {
    const q = queue();
    const listener = new InboxBackfillListener(makePrisma(), q as never);

    await listener.handleWatchEstablished({
      id: 'acct-1',
      email: 'se@acme.com',
    });

    const opts = q.add.mock.calls[0][2];
    expect(opts.attempts).toBeGreaterThan(1);
    expect(opts.backoff?.type).toBe('exponential');
    expect(opts.backoff?.delay).toBeGreaterThanOrEqual(60_000);
  });

  // Connecting twice, or a duplicated event, must not re-walk 500 messages.
  it('collapses repeat connections onto a single queued backfill', async () => {
    const q = queue();
    const listener = new InboxBackfillListener(makePrisma(), q as never);

    await listener.handleWatchEstablished({
      id: 'acct-1',
      email: 'se@acme.com',
    });
    await listener.handleWatchEstablished({
      id: 'acct-1',
      email: 'se@acme.com',
    });

    expect(q.add).toHaveBeenCalledTimes(2);
    expect([...q.jobs.keys()]).toEqual(['backfill#se@acme.com']);
  });

  it('keys the job on the address, so a second mailbox gets its own', async () => {
    const q = queue();
    const listener = new InboxBackfillListener(makePrisma(), q as never);

    await listener.handleWatchEstablished({ id: 'a', email: 'one@acme.com' });
    await listener.handleWatchEstablished({ id: 'b', email: 'two@acme.com' });

    expect([...q.jobs.keys()]).toEqual([
      'backfill#one@acme.com',
      'backfill#two@acme.com',
    ]);
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

    await listener.handleWatchEstablished({
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

    await listener.handleWatchEstablished({
      id: 'a',
      email: 'se@acme.com',
    });

    expect(q.add).not.toHaveBeenCalled();
  });
});

/**
 * The ordering the whole listener rewrite is about, wired through a real
 * EventEmitter2 rather than asserted on either half alone: nothing may list
 * the backlog until the watch baseline is stored, or a message arriving in
 * between belongs to neither set and is never classified at all.
 */
describe('inbox backfill — connect ordering', () => {
  const build = async (watchThrows = false) => {
    const add = jest.fn().mockResolvedValue({});
    const upsert = jest.fn().mockResolvedValue({});
    const watch = watchThrows
      ? jest.fn().mockRejectedValue(new Error('watch failed'))
      : jest.fn().mockResolvedValue({
          data: { expiration: '1893456000000', historyId: 12345 },
        });

    const prisma = makePrisma({
      webhookSubscription: { upsert },
    });

    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        GmailWebhookService,
        InboxBackfillListener,
        { provide: PrismaService, useValue: prisma },
        {
          provide: GmailClientFactory,
          useValue: {
            createClient: jest.fn().mockResolvedValue({
              users: {
                watch,
                labels: jest.fn(),
                messages: jest.fn(),
              },
            }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('projects/x/topics/gmail'),
          },
        },
        { provide: getQueueToken(BACKFILL_QUEUE), useValue: { add } },
      ],
    }).compile();
    // @OnEvent handlers are bound on the bootstrap hook, not on compile().
    await moduleRef.init();

    return {
      emitter: moduleRef.get(EventEmitter2),
      close: () => moduleRef.close(),
      add,
      upsert,
    };
  };

  /**
   * `emit` hands control to a listener but does not wait for it; the backfill
   * listener awaits a Prisma lookup before it enqueues. Flush the microtasks
   * that leaves pending.
   */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('queues the backfill only after the watch baseline is stored', async () => {
    const { emitter, close, add, upsert } = await build();

    await emitter.emitAsync('google.account.connected', {
      id: 'acct-1',
      email: 'se@acme.com',
    });
    await settle();

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    // The whole point: the snapshot is taken from behind the baseline, never
    // in front of it.
    expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(
      add.mock.invocationCallOrder[0],
    );
    await close();
  });

  // A backfill needs the same credentials the watch just failed to use, and
  // without a baseline there is no forward feed to hand over to either.
  it('queues nothing when the watch could not be established', async () => {
    const { emitter, close, add, upsert } = await build(true);

    await emitter.emitAsync('google.account.connected', {
      id: 'acct-1',
      email: 'se@acme.com',
    });
    await settle();

    expect(upsert).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    await close();
  });
});

describe('inbox backfill — config bounds', () => {
  const KEY = 'BACKFILL_TEST_BOUND';
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env[KEY];
    warn.mockRestore();
  });

  // Each of these used to be accepted and handed to Gmail as `maxResults`.
  it.each(['0', '-1', 'abc', '2.5', '', '  '])(
    'falls back loudly on %p',
    (raw) => {
      process.env[KEY] = raw;

      expect(positiveIntFromEnv(KEY, 500)).toBe(500);
    },
  );

  it('warns about the value it rejected', () => {
    process.env[KEY] = '-1';

    positiveIntFromEnv(KEY, 500);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('-1'));
  });

  it('honours a positive integer override', () => {
    process.env[KEY] = '25';

    expect(positiveIntFromEnv(KEY, 500)).toBe(25);
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses the fallback when the variable is unset', () => {
    expect(positiveIntFromEnv(KEY, 90)).toBe(90);
    expect(warn).not.toHaveBeenCalled();
  });

  // Whatever a deployment sets, what reaches Gmail is usable.
  it('exposes bounds that are always positive integers', () => {
    for (const bound of [BACKFILL_MAX_MESSAGES, BACKFILL_NEWER_THAN_DAYS]) {
      expect(Number.isInteger(bound)).toBe(true);
      expect(bound).toBeGreaterThan(0);
    }
  });
});
