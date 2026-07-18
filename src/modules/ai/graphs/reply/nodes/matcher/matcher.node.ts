import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ReplyGraphDependencies } from '@/modules/ai/graphs/reply/reply-graph.factory';
import type { ReplyGraphStateType } from '@/modules/ai/graphs/reply/reply-graph.state';
import {
  RecommendationSchema,
  AnswerSchema,
  MatchResult,
  ExclusionOutput,
} from './matcher.schema';
import {
  MATCHER_RECOMMEND_SYSTEM_PROMPT,
  MATCHER_ANSWER_SYSTEM_PROMPT,
  MATCHER_USER_PROMPT,
} from './matcher.prompt';
import { wrapUntrustedContent } from '@/common/security/untrusted-content.wrapper';

const logger = new Logger('MatcherNode');

/** How many chunks we hand the LLM. Enough context for answers that span
 *  chunks, small enough to fit the prompt. */
const TOP_K = 5;
/** How many candidates each search method contributes before fusion. */
const SEARCH_POOL = 20;
/** RRF dampening constant — the default from the paper that introduced
 *  Reciprocal Rank Fusion (Cormack et al.); nothing to tune. */
const RRF_K = 60;

export interface RetrievedChunk {
  id: string;
  content: string;
  chunkIndex: number | null;
  documentId: string;
  tenantId: string;
  isLowConfidence: boolean;
  similarity: number;
}

/** Layer 2 of tenant isolation: re-check every returned row. Redundant on
 *  purpose — one bug in one query must never be enough to leak a tenant's
 *  documents to another. */
function assertTenant(rows: RetrievedChunk[], tenantId: string): void {
  for (const row of rows) {
    if (row.tenantId !== tenantId) {
      logger.error(
        `SECURITY INCIDENT: retrieval returned chunk ${row.id} of tenant ${row.tenantId} while serving tenant ${tenantId}`,
      );
      throw new Error('matcher: cross-tenant row in retrieval results');
    }
  }
}

/** Semantic half: closest meaning first, via pgvector cosine distance. */
export async function semanticSearch(
  tenantId: string,
  queryText: string,
  deps: Pick<ReplyGraphDependencies, 'prisma' | 'aiModelService'>,
): Promise<RetrievedChunk[]> {
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
    LIMIT ${SEARCH_POOL}
  `);
  assertTenant(rows, tenantId);
  return rows;
}

/**
 * Keyword half: exact-token matching via Postgres full-text search.
 * Embeddings are systematically weak on exact identifiers (SKUs, model
 * numbers, part codes) — this half never misses a literal token.
 * to_tsvector is computed inline: at the measured corpus size (Stage 0)
 * a GIN index would be premature; revisit when the count says otherwise.
 */
export async function keywordSearch(
  tenantId: string,
  queryText: string,
  prisma: ReplyGraphDependencies['prisma'],
): Promise<RetrievedChunk[]> {
  // OR semantics, built by hand: plainto_tsquery ANDs every term, so a
  // 20-word email would only match chunks containing ALL 20 stems — i.e.
  // nothing. With OR, ts_rank naturally rewards chunks matching the rare
  // terms (the SKUs) over ones matching common words.
  const orQuery = queryText
    .split(/[^\p{L}\p{N}]+/u) // keep only letter/digit runs — sanitises tsquery syntax
    .filter((term) => term.length > 1)
    .join(' | ');
  if (!orQuery) return [];

  const rows = await prisma.$queryRaw<RetrievedChunk[]>(Prisma.sql`
    SELECT c.id,
           c.content,
           c.chunk_index                             AS "chunkIndex",
           c.document_id                             AS "documentId",
           d.tenant_id                               AS "tenantId",
           d.is_low_confidence                       AS "isLowConfidence",
           0::float8                                 AS similarity
    FROM document_chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.tenant_id = ${tenantId}::uuid
      AND c.content IS NOT NULL
      AND to_tsvector('english', c.content)
          @@ to_tsquery('english', ${orQuery})
    ORDER BY ts_rank(
      to_tsvector('english', c.content),
      to_tsquery('english', ${orQuery})
    ) DESC
    LIMIT ${SEARCH_POOL}
  `);
  assertTenant(rows, tenantId);
  return rows;
}

/**
 * Reciprocal Rank Fusion: score = Σ 1/(RRF_K + rank position). Uses only
 * rank positions — cosine similarity and ts_rank are incomparable scales,
 * so blending their raw scores would mean inventing a weight and defending
 * it forever. Ranked well in BOTH lists beats ranked well in one.
 */
export function rrfFuse(lists: RetrievedChunk[][]): RetrievedChunk[] {
  const byId = new Map<string, { chunk: RetrievedChunk; score: number }>();
  for (const list of lists) {
    list.forEach((chunk, position) => {
      const entry = byId.get(chunk.id) ?? { chunk, score: 0 };
      entry.score += 1 / (RRF_K + position + 1);
      // Prefer the semantic instance (has a real similarity value).
      if (chunk.similarity > entry.chunk.similarity) entry.chunk = chunk;
      byId.set(chunk.id, entry);
    });
  }
  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .map((e) => e.chunk);
}

/**
 * Neighbour expansion: for every hit, also fetch the chunks physically
 * before and after it in the same document (chunk_index ± 1).
 *
 * Why: procedures get split across chunks. The middle steps match the
 * question; the safety precondition in the previous chunk doesn't. The
 * answer would be correct-but-amputated — every word cited, the warning
 * silently gone — a failure the hallucination gate cannot see.
 * Uses idx_chunks_doc, which already exists. One cheap query.
 */
export async function expandNeighbours(
  hits: RetrievedChunk[],
  tenantId: string,
  prisma: ReplyGraphDependencies['prisma'],
): Promise<RetrievedChunk[]> {
  const anchors = hits.filter((c) => c.chunkIndex !== null);
  if (anchors.length === 0) return hits;

  const wanted = anchors.map(
    (c) =>
      Prisma.sql`(c.document_id = ${c.documentId}::uuid
                  AND c.chunk_index IN (${c.chunkIndex! - 1}, ${c.chunkIndex! + 1}))`,
  );

  const neighbours = await prisma.$queryRaw<RetrievedChunk[]>(Prisma.sql`
    SELECT c.id,
           c.content,
           c.chunk_index                             AS "chunkIndex",
           c.document_id                             AS "documentId",
           d.tenant_id                               AS "tenantId",
           d.is_low_confidence                       AS "isLowConfidence",
           0::float8                                 AS similarity
    FROM document_chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.tenant_id = ${tenantId}::uuid
      AND (${Prisma.join(wanted, ' OR ')})
  `);
  assertTenant(neighbours, tenantId);

  // Dedupe: a neighbour that was already a hit stays a hit.
  const seen = new Set(hits.map((c) => c.id));
  const fresh = neighbours.filter((c) => !seen.has(c.id));

  // Keep reading order inside each document: sort everything by
  // (document, position) so the LLM reads procedures in sequence.
  return [...hits, ...fresh].sort((a, b) =>
    a.documentId === b.documentId
      ? (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0)
      : a.documentId.localeCompare(b.documentId),
  );
}

/**
 * Hybrid retrieval: semantic (meaning) + keyword (exact tokens), fused
 * with RRF, top K, then neighbour-expanded. Both halves are tenant-scoped
 * (layer 1: SQL filter) and re-checked (layer 2: assertTenant).
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

  const [semantic, keyword] = await Promise.all([
    semanticSearch(tenantId, queryText, deps),
    keywordSearch(tenantId, queryText, deps.prisma),
  ]);

  const topHits = rrfFuse([semantic, keyword]).slice(0, TOP_K);
  return expandNeighbours(topHits, tenantId, deps.prisma);
}

type MatchPath = 'recommendation' | 'answer';

/**
 * CODE decides the path from the classifier's intent — never the model.
 * A model routing itself can misroute itself, invisibly.
 * 'sensitive' takes the answer path: the safest thing an auto-drafter can
 * do with a sensitive email is answer facts without pitching anything.
 * Missing intent falls back to recommendation (the pre-fork behavior)
 * until the caller contract (S-AI-7) supplies it.
 */
export function routeByIntent(intent: string | undefined): MatchPath {
  if (intent === 'support' || intent === 'follow-up' || intent === 'sensitive')
    return 'answer';
  return 'recommendation'; // 'product inquiry', 'demo request', or unknown
}

/**
 * The matcher's view of "what does the client need": explicit requirements
 * win, then the extractor node's structured output, then nothing (the
 * caller falls back to the raw email). Exported so the composer can show
 * the same list the matcher searched with.
 */
export function requirementsFromState(state: ReplyGraphStateType): string[] {
  if (state.requirements?.length) return state.requirements;
  const ex = state.extractorResult;
  if (!ex) return [];
  return [
    ...ex.features,
    ...(ex.constraints ? [`constraint: ${ex.constraints}`] : []),
    ...(ex.scale ? [`scale: ${ex.scale}`] : []),
    ...(ex.budgetHint ? [`budget: ${ex.budgetHint}`] : []),
    ...(ex.timeline ? [`timeline: ${ex.timeline}`] : []),
  ];
}

/** Merge an LLM result with the code-computed fields all paths share:
 *  validated citations, the DB quality flag, and the chunk texts. */
function enrich(
  base: { reasoning: string; confidence: number; citedChunks: string[] },
  extra: {
    resultType: MatchPath;
    recommendedProduct: string | null;
    exclusions: ExclusionOutput[];
  },
  chunks: RetrievedChunk[],
): MatchResult {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  // Cited IDs must be real. Drop anything the model invented.
  const citedChunks = base.citedChunks.filter((id) => byId.has(id));
  return {
    ...extra,
    reasoning: base.reasoning,
    confidence: base.confidence,
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
}

/**
 * The matcher node: retrieve (tenant-scoped, shared) → route by intent →
 * one LLM call with the path's own flat schema → MatchResult.
 * A chain step, not an agent — no model-decided control flow.
 */
export async function matcherNode(
  state: ReplyGraphStateType,
  deps: Pick<ReplyGraphDependencies, 'prisma' | 'aiModelService'>,
): Promise<Partial<ReplyGraphStateType>> {
  // The distilled needs (explicit or extractor-derived) are the search
  // query; the raw email is the fallback when neither exists.
  const requirements = requirementsFromState(state);
  const queryText = requirements.length
    ? requirements.join('\n')
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
      requirements.length
        ? requirements.map((r) => `- ${r}`).join('\n')
        : 'None extracted — derive them from the email.',
    )
    .replace(
      '{excludedProducts}',
      state.excludedByUser?.length
        ? state.excludedByUser.map((p) => `- ${p}`).join('\n')
        : 'None.',
    )
    .replace('{productChunks}', chunkBlock);

  const path = routeByIntent(state.intent);

  let matchResult: MatchResult;
  if (path === 'recommendation') {
    const llm = await deps.aiModelService.generateStructured({
      schema: RecommendationSchema,
      runName: 'MatcherRecommend',
      messages: [
        { role: 'system', content: MATCHER_RECOMMEND_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });

    // Trust, but verify: the prompt forbids excluded products, and code
    // checks anyway — same pattern as citations. If the model recommended
    // an excluded product, don't pass it through: null it, zero the
    // confidence, and say why, so the Supervisor/user sees an honest miss
    // instead of a silently repeated rejection.
    const excluded = new Set(
      (state.excludedByUser ?? []).map((p) => p.trim().toLowerCase()),
    );
    if (excluded.has(llm.recommendedProduct.trim().toLowerCase())) {
      logger.warn(
        `model recommended excluded product "${llm.recommendedProduct}" despite instructions`,
      );
      matchResult = enrich(
        {
          ...llm,
          confidence: 0,
          reasoning: `The best-fitting product ("${llm.recommendedProduct}") was excluded by the user and no alternative was found. Original reasoning: ${llm.reasoning}`,
        },
        {
          resultType: 'recommendation',
          recommendedProduct: null,
          exclusions: [
            ...llm.exclusions,
            { product: llm.recommendedProduct, reason: 'Excluded by the user' },
          ],
        },
        chunks,
      );
      return { matchResult };
    }

    matchResult = enrich(
      llm,
      {
        resultType: 'recommendation',
        recommendedProduct: llm.recommendedProduct,
        exclusions: llm.exclusions,
      },
      chunks,
    );
  } else {
    // The answer form has no product field — nothing to wrongly fill.
    const llm = await deps.aiModelService.generateStructured({
      schema: AnswerSchema,
      runName: 'MatcherAnswer',
      messages: [
        { role: 'system', content: MATCHER_ANSWER_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });
    matchResult = enrich(
      llm,
      { resultType: 'answer', recommendedProduct: null, exclusions: [] },
      chunks,
    );
  }

  return { matchResult };
}
