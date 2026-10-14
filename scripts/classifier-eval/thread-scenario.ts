/**
 * Demonstrates: two messages in ONE Gmail thread each get classified
 * independently and stored as SEPARATE general_analysis rows (same threadId,
 * different intent), keyed by messageId. Uses the real classifier (real LLM)
 * and writes to the real general_analysis table, then prints and cleans up.
 *
 * Run: TS_NODE_TRANSPILE_ONLY=1 npx ts-node -r tsconfig-paths/register \
 *        scripts/classifier-eval/thread-scenario.ts
 */
import './_env';
import { buildClassifier } from './_classifier';
import { PrismaClient } from '@prisma/client';
import { prepareEmailText } from '../../src/modules/ai/classifier/email-text.util';
import { CLASSIFIER_PROMPT_VERSION } from '../../src/modules/ai/classifier/classifier.constants';

const THREAD = 'demo-thread-scenario';
const ACCOUNT = 'demo-se@example.com';

// Two messages in the same thread, in arrival order.
const messages = [
  {
    messageId: 'demo-msg-1',
    subject: 'Enterprise plan question',
    body: "Hi, does your enterprise plan support 500 users and integrate with SAP? What's the pricing?",
  },
  {
    messageId: 'demo-msg-2',
    subject: 'Re: Enterprise plan question',
    // New text = follow-up; the quoted vendor answer below gets stripped.
    body:
      "Thanks, that's really helpful. I'll review with my team and get back to you.\n\n" +
      'On Mon, Jul 13, 2026 at 9:00 AM Sales <sales@x.com> wrote:\n' +
      '> Our enterprise plan supports 500 users and integrates with SAP.\n' +
      '> Pricing starts at 40,000 USD/year. Would you like a demo this week?',
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const prisma = new PrismaClient();
  const classifier = buildClassifier();

  // idempotent: clear any leftovers from a previous run
  await prisma.generalAnalysis.deleteMany({ where: { threadId: THREAD } });

  for (const m of messages) {
    const cleanedBody = prepareEmailText(m.body);
    const text = m.subject
      ? `Subject: ${m.subject}\n\n${cleanedBody}`.trim()
      : cleanedBody;

    console.log(`\n▶ ${m.messageId}`);
    console.log(
      '  what the classifier sees:',
      JSON.stringify(text.slice(0, 90)) + '…',
    );

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
      '  stored ->',
      JSON.stringify({ intent: result.intent, isUrgent: result.isUrgent }),
    );
    await sleep(1200);
  }

  // Read them back — this is what the Extractor / Urgent tab would query.
  const rows = await prisma.generalAnalysis.findMany({
    where: { threadId: THREAD },
    orderBy: { messageId: 'asc' },
    select: {
      messageId: true,
      threadId: true,
      intent: true,
      isUrgent: true,
      intentConfidence: true,
    },
  });

  console.log(
    '\n===== general_analysis rows for thread "' + THREAD + '" =====',
  );
  console.table(rows);
  console.log(
    `\n${rows.length} rows — one per message, same threadId, independent intents.`,
  );

  // Clean up the demo rows (shared DB — leave no test data behind).
  await prisma.generalAnalysis.deleteMany({ where: { threadId: THREAD } });
  console.log('(demo rows cleaned up)');
  await prisma.$disconnect();
}

void main();
