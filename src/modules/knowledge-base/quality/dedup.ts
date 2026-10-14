import { PrismaService } from '../../../database/prisma.service';

const SIMILARITY_THRESHOLD = 0.95; // cosine similarity; 1 - (a <=> b)

export interface Redundancy {
  duplicateChunkPairs: number;
  redundancyRatio: number;
  concisenessScore: number;
}

export async function computeRedundancy(
  prisma: PrismaService,
  documentId: string,
): Promise<Redundancy> {
  const pairRows = await prisma.$queryRaw<{ pairs: bigint }[]>`
    SELECT COUNT(*)::bigint AS pairs
    FROM document_chunks a
    JOIN document_chunks b
      ON a.document_id = b.document_id AND a.id < b.id
    WHERE a.document_id = ${documentId}::uuid
      AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
      AND 1 - (a.embedding <=> b.embedding) >= ${SIMILARITY_THRESHOLD}
  `;
  const countRows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM document_chunks
    WHERE document_id = ${documentId}::uuid
  `;
  const duplicateChunkPairs = Number(pairRows[0]?.pairs ?? 0n);
  const total = Number(countRows[0]?.n ?? 0n);
  // Each duplicate pair ≈ one redundant chunk; clamp to [0,1].
  const redundancyRatio =
    total === 0 ? 0 : Math.min(1, duplicateChunkPairs / total);
  const concisenessScore = Math.round(100 * (1 - redundancyRatio));
  return { duplicateChunkPairs, redundancyRatio, concisenessScore };
}
