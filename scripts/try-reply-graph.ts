/**
 * Stage 5 verification: the full reply graph end to end —
 * START → match (retrieve + LLM) → compose → END.
 *
 * Invoked directly, not over HTTP: nothing calls draftReply yet
 * (/ai/process is S-AI-7). Run from backend/:
 *   node --env-file=.env -r ts-node/register/transpile-only scripts/try-reply-graph.ts
 */
import { ConfigService } from '@nestjs/config';
import { AiModelService } from '../src/modules/ai/ai.model.service';
import { PrismaService } from '../src/database/prisma.service';
import { buildReplyGraph } from '../src/modules/ai/graphs/reply/reply-graph.factory';

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

    // The dev corpus is a resume, so the "product" being matched is a
    // person's skills — fine for proving the pipeline shape.
    const finalState = await graph.invoke({
      emailId: 'test-email-1',
      tenantId,
      emailBody:
        'Hi, we are looking for someone experienced with React and Angular ' +
        'to help build our web dashboard. Do you have anyone who fits?',
      excludedByUser: [],
    });

    console.log('=== matchResult ===');
    const m = finalState.matchResult;
    console.log(
      JSON.stringify(
        {
          ...m,
          citedChunkDetails: m?.citedChunkDetails.map((c) => ({
            id: c.id,
            content: c.content.slice(0, 60) + '…',
          })),
        },
        null,
        2,
      ),
    );

    console.log('\n=== composer draft ===');
    console.log(finalState.composerResult?.draftText);
    console.log('\n=== composer claims ===');
    for (const claim of finalState.composerResult?.claims ?? []) {
      console.log(`  [${claim.status}] ${claim.text}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
