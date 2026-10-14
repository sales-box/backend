/**
 * Scenario 2: one thread that escalates. Shows that urgency and intent are
 * decided PER MESSAGE, not per thread — an urgent support message and a new
 * demo ask land mid-thread and are classified on their own new text (quotes
 * stripped), even though the thread started as a calm product inquiry.
 *
 * Run: TS_NODE_TRANSPILE_ONLY=1 npx ts-node -r tsconfig-paths/register \
 *        scripts/classifier-eval/thread-escalation.ts
 */
import './_env';
import { buildClassifier } from './_classifier';
import { PrismaClient } from '@prisma/client';
import { prepareEmailText } from '../../src/modules/ai/classifier/email-text.util';
import { CLASSIFIER_PROMPT_VERSION } from '../../src/modules/ai/classifier/classifier.constants';

const THREAD = 'demo-thread-escalation';
const ACCOUNT = 'demo-se@example.com';
const QUOTE =
  '\n\nOn Mon, Jul 13, 2026 at 9:00 AM Sales <sales@x.com> wrote:\n' +
  '> Our platform supports role-based access and integrates with your stack.\n' +
  '> Pricing starts at 25,000 USD/year.';

// All from the client, in arrival order — a calm thread that escalates.
const messages = [
  {
    messageId: 'esc-1',
    subject: 'Question about your platform',
    body: 'Hi, does your platform support role-based access for about 200 users? What does it cost?',
    expect: 'product inquiry, not urgent',
  },
  {
    messageId: 'esc-2',
    subject: 'Re: Question about your platform',
    body:
      "Thanks for the details. I'll discuss internally and circle back." +
      QUOTE,
    expect: 'follow-up, not urgent (quote stripped)',
  },
  {
    messageId: 'esc-3',
    subject: 'Re: Question about your platform',
    body:
      'Update - our trial environment just crashed and we have a board demo tomorrow morning. We need this working urgently, please help.' +
      QUOTE,
    expect:
      'support + URGENT (urgency appears mid-thread; new ask beats follow-up)',
  },
  {
    messageId: 'esc-4',
    subject: 'Re: Question about your platform',
    body:
      'Also, separately, can we book a proper live demo for Thursday? We must decide by Friday.' +
      QUOTE,
    expect: 'demo request (new ask beats follow-up)',
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const prisma = new PrismaClient();
  const classifier = buildClassifier();

  await prisma.generalAnalysis.deleteMany({ where: { threadId: THREAD } });

  for (const m of messages) {
    const text = `Subject: ${m.subject}\n\n${prepareEmailText(m.body)}`.trim();
    console.log(`\n▶ ${m.messageId}  (expect: ${m.expect})`);

    let result;
    for (let attempt = 1; ; attempt++) {
      try {
        result = await classifier.classify(text);
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        await sleep(3000);
      }
    }

    await prisma.generalAnalysis.create({
      data: {
        messageId: m.messageId,
        threadId: THREAD,
        accountEmail: ACCOUNT,
        tenantId: null,
        isUrgent: result.isUrgent,
        urgencyReason: result.urgencyReason,
        intent: result.intent,
        intentConfidence: result.intentConfidence,
        reasoning: result.reasoning,
        promptVersion: CLASSIFIER_PROMPT_VERSION,
      },
    });
    console.log(
      '  ->',
      JSON.stringify({
        intent: result.intent,
        isUrgent: result.isUrgent,
        urgencyReason: result.urgencyReason,
      }),
    );
    await sleep(1200);
  }

  const rows = await prisma.generalAnalysis.findMany({
    where: { threadId: THREAD },
    orderBy: { messageId: 'asc' },
    select: {
      messageId: true,
      intent: true,
      isUrgent: true,
      intentConfidence: true,
    },
  });
  console.log('\n===== general_analysis rows (thread "' + THREAD + '") =====');
  console.table(rows);

  await prisma.generalAnalysis.deleteMany({ where: { threadId: THREAD } });
  console.log('(demo rows cleaned up)');
  await prisma.$disconnect();
}

void main();
