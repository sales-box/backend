/**
 * One-shot backfill: embed every document_chunk whose embedding is NULL.
 *
 * Run from backend/:
 *   node --env-file=.env -r ts-node/register/transpile-only scripts/backfill-embeddings.ts
 *
 * Idempotent by construction — it only ever selects NULL-embedding rows,
 * so re-running after a crash (or after new uploads) is always safe.
 *
 * Deliberately does NOT boot the Nest app: createApplicationContext(AppModule)
 * would start the Gmail polling scheduler and BullMQ workers as a side effect.
 * A repair script should touch the DB and the embedding API, nothing else.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { OpenAIEmbeddings } from '@langchain/openai';

const BATCH_SIZE = 50;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Missing env var ${name} — run with --env-file=.env`);
  return value;
}

async function main() {
  const prisma = new PrismaClient();
  const embeddings = new OpenAIEmbeddings({
    apiKey: requireEnv('EMBEDDING_API_KEY'),
    model: requireEnv('EMBEDDING_MODEL'),
    configuration: { baseURL: requireEnv('EMBEDDING_BASE_URL') },
  });

  let done = 0;
  try {
    for (;;) {
      const batch = await prisma.$queryRaw<{ id: string; content: string }[]>`
        SELECT id, content
        FROM document_chunks
        WHERE embedding IS NULL AND content IS NOT NULL
        LIMIT ${BATCH_SIZE}
      `;
      if (batch.length === 0) break;

      const vectors = await embeddings.embedDocuments(
        batch.map((c) => c.content),
      );

      for (let i = 0; i < batch.length; i++) {
        // Raw SQL because Prisma types the column as Unsupported("vector").
        // pgvector accepts the '[0.1,0.2,...]' text form via a ::vector cast.
        await prisma.$executeRaw`
          UPDATE document_chunks
          SET embedding = ${JSON.stringify(vectors[i])}::vector
          WHERE id = ${batch[i].id}::uuid
        `;
      }

      done += batch.length;
      console.log(`embedded ${done} chunks (dims=${vectors[0]?.length})`);
    }

    const remaining = await prisma.$queryRaw<{ n: bigint }[]>(
      Prisma.sql`SELECT count(*) AS n FROM document_chunks WHERE embedding IS NULL AND content IS NOT NULL`,
    );
    console.log(
      `done. total embedded this run: ${done}; still NULL: ${remaining[0].n}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
