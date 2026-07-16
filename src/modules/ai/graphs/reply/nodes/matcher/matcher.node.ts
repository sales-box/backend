import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ReplyGraphDependencies } from '@/modules/ai/graphs/reply/reply-graph.factory';

const logger = new Logger('MatcherNode');

/** How many chunks we hand the LLM. Enough context for answers that span
 *  chunks, small enough to fit the prompt. */
const TOP_K = 5;

export interface RetrievedChunk {
  id: string;
  content: string;
  chunkIndex: number | null;
  documentId: string;
  tenantId: string;
  isLowConfidence: boolean;
  similarity: number;
}

/**
 * Semantic retrieval with two independent tenant-isolation layers.
 *
 * Layer 1 (query): JOIN documents and filter on d.tenant_id — chunks have
 * no tenant column of their own, only their parent document does.
 * Layer 2 (code): re-check every returned row. Redundant on purpose: one
 * bug in one query must never be enough to leak a tenant's documents.
 */
export async function retrieveChunks(
  tenantId: string,
  queryText: string,
  deps: Pick<ReplyGraphDependencies, 'prisma' | 'aiModelService'>,
): Promise<RetrievedChunk[]> {
  if (!tenantId) {
    // Never a silent empty result: a missing tenant is an upstream bug,
    // and silence would hide it.
    throw new Error(
      'matcher: tenantId is missing — refusing to search without a tenant scope',
    );
  }

  const queryVector = await deps.aiModelService.embedQuery(queryText);
  // pgvector takes vectors as '[0.1,0.2,...]' text cast with ::vector;
  // JSON.stringify of a number[] produces exactly that shape.
  const vectorLiteral = JSON.stringify(queryVector);

  // <=> returns cosine DISTANCE (smaller = closer). Downstream wants
  // similarity (bigger = better), hence the 1 - x.
  const rows = await deps.prisma.$queryRaw<RetrievedChunk[]>(Prisma.sql`
    SELECT c.id,
           c.content,
           c.chunk_index                             AS "chunkIndex",
           c.document_id                             AS "documentId",
           d.tenant_id                               AS "tenantId",
           d.is_low_confidence                       AS "isLowConfidence",
           1 - (c.embedding <=> ${vectorLiteral}::vector) AS similarity
    FROM document_chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.tenant_id = ${tenantId}::uuid
      AND c.embedding IS NOT NULL
    ORDER BY c.embedding <=> ${vectorLiteral}::vector
    LIMIT ${TOP_K}
  `);

  for (const row of rows) {
    if (row.tenantId !== tenantId) {
      logger.error(
        `SECURITY INCIDENT: retrieval returned chunk ${row.id} of tenant ${row.tenantId} while serving tenant ${tenantId}`,
      );
      throw new Error('matcher: cross-tenant row in retrieval results');
    }
  }

  return rows;
}
