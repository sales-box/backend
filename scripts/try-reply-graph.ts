/**
 * Full reply graph end to end — START → match (retrieve + LLM) → compose.
 * Runs BOTH matcher paths: a buying email (recommendation) and a support
 * question (answer).
 *
 * Invoked directly, not over HTTP: nothing calls draftReply yet
 * (/ai/process is S-AI-7). Run from backend/:
 *   node --env-file=.env -r tsconfig-paths/register -r ts-node/register/transpile-only scripts/try-reply-graph.ts
 */
import { ConfigService } from '@nestjs/config';
import { AiModelService } from '../src/modules/ai/ai.model.service';
import { PrismaService } from '../src/database/prisma.service';
import { buildReplyGraph } from '../src/modules/ai/graphs/reply/reply-graph.factory';
import type { Intent } from '../src/modules/ai/classifier/classifier.types';

const SCENARIOS: { name: string; intent: Intent; emailBody: string }[] = [
  {
    name: 'RECOMMENDATION path (product inquiry)',
    intent: 'product inquiry',
    emailBody:
      'Hi, we are looking for someone experienced with React and Angular ' +
      'to help build our web dashboard. Do you have anyone who fits?',
  },
  {
    name: 'ANSWER path (support question)',
    intent: 'support',
    emailBody:
      'Quick question: does your engineer have experience with Django, ' +
      'and which databases has he worked with?',
  },
];

async function main() {
  const config = new ConfigService(process.env);
  const aiModelService = new AiModelService(config);
  const prisma = new PrismaService();

  try {
    const tenant = await prisma.$queryRaw<{ tenantId: string }[]>`
      SELECT tenant_id AS "tenantId" FROM documents LIMIT 1
    `;
    if (!tenant.length) throw new Error('no documents in DB');
    const tenantId = tenant[0].tenantId;

    const graph = buildReplyGraph({ aiModelService, prisma });

    for (const s of SCENARIOS) {
      console.log(`\n════════ ${s.name} ════════`);
      const finalState = await graph.invoke({
        emailId: 'test-email-1',
        tenantId,
        emailBody: s.emailBody,
        intent: s.intent,
        excludedByUser: [],
        attachmentsText: [],
        externalContentText: [],
      });

      const m = finalState.matchResult;
      console.log(`resultType:          ${m?.resultType}`);
      console.log(`recommendedProduct:  ${m?.recommendedProduct}`);
      console.log(`confidence:          ${m?.confidence}`);
      console.log(`reasoning:           ${m?.reasoning}`);
      console.log(
        `citedChunks:         ${m?.citedChunks.length} of ${m?.citedChunkDetails.length} details`,
      );
      console.log(`lowConfidenceSource: ${m?.basedOnLowConfidenceSource}`);
      console.log(`--- composer draft ---`);
      console.log(finalState.composerResult?.draftText);
      console.log(`--- claims ---`);
      for (const claim of finalState.composerResult?.claims ?? []) {
        console.log(`  [${claim.status}] ${claim.text}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
