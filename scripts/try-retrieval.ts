/**
 * Stage 4 verification: semantic retrieval + tenant isolation, run directly
 * against the dev DB (nothing calls draftReply yet — S-AI-7 is Khaled's).
 *
 * Run from backend/:
 *   node --env-file=.env -r ts-node/register/transpile-only scripts/try-retrieval.ts
 */
import { ConfigService } from '@nestjs/config';
import { AiModelService } from '../src/modules/ai/ai.model.service';
import { PrismaService } from '../src/database/prisma.service';
import { retrieveChunks } from '../src/modules/ai/graphs/reply/nodes/matcher/matcher.node';

async function main() {
  const config = new ConfigService(process.env);
  const aiModelService = new AiModelService(config);
  const prisma = new PrismaService();
  const deps = { prisma, aiModelService };

  try {
    const tenants = await prisma.$queryRaw<
      { tenantId: string; docs: bigint }[]
    >`
      SELECT d.tenant_id AS "tenantId", count(*) AS docs
      FROM documents d GROUP BY 1 ORDER BY 1
    `;
    console.log(`tenants owning documents: ${tenants.length}\n`);

    const query = 'software engineering skills and experience';

    for (const t of tenants) {
      const rows = await retrieveChunks(t.tenantId, query, deps);
      const foreign = rows.filter((r) => r.tenantId !== t.tenantId);
      console.log(
        `tenant ${t.tenantId.slice(0, 8)}…  got ${rows.length} chunks, foreign rows: ${foreign.length}`,
      );
      for (const r of rows) {
        console.log(
          `   sim=${r.similarity.toFixed(3)}  owner=${r.tenantId.slice(0, 8)}…  "${(r.content ?? '').slice(0, 40).replace(/\n/g, ' ')}"`,
        );
      }
    }

    console.log('\nmissing tenantId must throw:');
    try {
      await retrieveChunks('', query, deps);
      console.log('   ✗ DID NOT THROW — BUG');
      process.exitCode = 1;
    } catch (e) {
      console.log(`   ✓ threw: ${(e as Error).message}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
