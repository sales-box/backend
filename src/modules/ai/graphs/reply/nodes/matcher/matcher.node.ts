import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ReplyGraphDependencies } from '@/modules/ai/graphs/reply/reply-graph.factory';
import type { ReplyGraphStateType } from '@/modules/ai/graphs/reply/reply-graph.state';
import { MatcherSchema, MatchResult } from './matcher.schema';
import { MATCHER_SYSTEM_PROMPT, MATCHER_USER_PROMPT } from './matcher.prompt';
import { wrapUntrustedContent } from '@/common/security/untrusted-content.wrapper';

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

/**
 * The matcher node: retrieve (tenant-scoped) → one LLM call → MatchResult.
 * A chain step, not an agent — no model-decided control flow.
 */
export async function matcherNode(
  state: ReplyGraphStateType,
  deps: Pick<ReplyGraphDependencies, 'prisma' | 'aiModelService'>,
): Promise<Partial<ReplyGraphStateType>> {
  // Requirements are the distilled question; the raw email is the fallback
  // until the extractor contract lands.
  const queryText = state.requirements?.length
    ? state.requirements.join('\n')
    : state.emailBody;

  const chunks = await retrieveChunks(state.tenantId, queryText, deps);

  if (chunks.length === 0) {
    // No grounding material — asking the LLM anyway would invite invention.
    logger.warn(`no chunks for tenant ${state.tenantId}; skipping LLM call`);
    return {
      matchResult: {
        resultType: 'answer',
        recommendedProduct: null,
        reasoning:
          'No relevant documents were found in the knowledge base for this request.',
        confidence: 0,
        citedChunks: [],
        exclusions: [],
        basedOnLowConfidenceSource: false,
        citedChunkDetails: [],
      },
    };
  }

  const chunkBlock = chunks
    .map((c) => `[chunk ${c.id}]\n${c.content ?? ''}`)
    .join('\n\n');

  const userMessage = MATCHER_USER_PROMPT.replace(
    '{intent}',
    state.intent ?? 'unknown (assume product inquiry)',
  )
    .replace('{emailBody}', wrapUntrustedContent(state.emailBody, 'email_body'))
    .replace(
      '{requirements}',
      state.requirements?.length
        ? state.requirements.map((r) => `- ${r}`).join('\n')
        : 'None extracted — derive them from the email.',
    )
    .replace('{productChunks}', chunkBlock);

  const llmResult = await deps.aiModelService.generateStructured({
    schema: MatcherSchema,
    runName: 'MatcherNode',
    messages: [
      { role: 'system', content: MATCHER_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  });

  // Code-side guards — never trust the model on rules code can enforce:
  // an "answer" claims no product choice, whatever the model filled in.
  const recommendedProduct =
    llmResult.resultType === 'answer' ? null : llmResult.recommendedProduct;
  // Cited IDs must be real. Drop anything the model invented.
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const citedChunks = llmResult.citedChunks.filter((id) => byId.has(id));

  const matchResult: MatchResult = {
    ...llmResult,
    recommendedProduct,
    citedChunks,
    // From the DB flag set by the knowledge-base quality gate — computed
    // here, never asked of the model.
    basedOnLowConfidenceSource: citedChunks.some(
      (id) => byId.get(id)!.isLowConfidence,
    ),
    citedChunkDetails: citedChunks.map((id) => ({
      id,
      content: byId.get(id)!.content ?? '',
    })),
  };

  return { matchResult };
}
