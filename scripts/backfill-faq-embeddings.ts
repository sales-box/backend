import { PrismaClient } from '@prisma/client';
import { OpenAIEmbeddings } from '@langchain/openai';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Missing env var ${name} — run with --env-file=.env`);
  return value;
}

async function main() {
  const prisma = new PrismaClient();
  const embeddingDimensions = process.env.EMBEDDING_DIMENSIONS;
  const embeddings = new OpenAIEmbeddings({
    apiKey: requireEnv('EMBEDDING_API_KEY'),
    model: requireEnv('EMBEDDING_MODEL'),
    ...(embeddingDimensions ? { dimensions: Number(embeddingDimensions) } : {}),
    configuration: { baseURL: requireEnv('EMBEDDING_BASE_URL') },
  });

  try {
    const items = await prisma.$queryRaw<{ id: string; question: string }[]>`
      SELECT id, question
      FROM faq_items
      WHERE embedding IS NULL
    `;

    console.log(`Found ${items.length} FAQ items without embeddings.`);
    if (items.length === 0) {
      console.log('No backfill needed.');
      return;
    }

    const texts = items.map((i) => i.question);
    const vectors = await embeddings.embedDocuments(texts);

    console.log(
      `Generated ${vectors.length} embeddings. Writing to database...`,
    );

    for (let i = 0; i < items.length; i++) {
      await prisma.$executeRaw`
        UPDATE faq_items
        SET embedding = ${JSON.stringify(vectors[i])}::vector
        WHERE id = ${items[i].id}::uuid
      `;
    }

    console.log('Backfill completed successfully.');
  } catch (err) {
    console.error('Backfill failed:', err);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);
