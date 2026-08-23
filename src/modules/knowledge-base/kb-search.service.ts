import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AiModelService } from '../ai/ai.model.service';
import {
  semanticSearch,
  keywordSearch,
  rrfFuse,
  type RetrievedChunk,
} from '../ai/graphs/reply/nodes/matcher/matcher.node';

/** How many results the admin sees. The reply pipeline uses 5; showing a few
 *  more here is useful — the point is to inspect retrieval, not to fit a prompt. */
const PREVIEW_TOP_K = 8;

/**
 * Display bands for cosine similarity. NOT a filter — retrieval returns what it
 * returns, and this screen exists to show the truth about that.
 *
 * They are here because vector search always hands back its top K whether or
 * not anything is actually relevant: asking a pump catalogue about submarines
 * still returns three passages, and without a label the admin reads that as
 * "my knowledge base covers submarines". Measured against this corpus, a real
 * answer scores ~0.5+ while unrelated text sits near ~0.2.
 */
const STRONG_SIMILARITY = 0.45;
const MODERATE_SIMILARITY = 0.3;

export type MatchStrength = 'strong' | 'moderate' | 'weak';

/** Which half of the hybrid search surfaced a chunk. */
export type FoundBy = 'semantic' | 'keyword' | 'both';

export interface KbSearchHit {
  chunkId: string;
  documentId: string;
  filename: string;
  chunkIndex: number | null;
  content: string;
  /** Cosine similarity from the semantic half. Null for keyword-only hits —
   *  the keyword query has no comparable score, and 0 would read as "no match". */
  similarity: number | null;
  /**
   * How well this passage actually matches. A hit the keyword half found never
   * falls below 'moderate' — it contains a literal token — but never gets
   * 'strong' on that alone, because the keyword query is OR over every word and
   * one shared ordinary word is enough to produce a hit.
   */
  strength: MatchStrength;
  foundBy: FoundBy;
  /** Document-level extraction warning, so a hit from a scanned PDF is visible. */
  isLowConfidence: boolean;
}

export type KbSearchOutcome =
  'ok' | 'empty_knowledge_base' | 'no_match' | 'weak_match';

export interface KbSearchResult {
  question: string;
  outcome: KbSearchOutcome;
  tookMs: number;
  /** Distinct chunks each half returned before fusion. */
  candidates: { semantic: number; keyword: number };
  hits: KbSearchHit[];
}

/**
 * "What would the AI find?" — retrieval on its own, without the reply.
 *
 * The Knowledge Base screen had a disabled placeholder for this while the
 * retrieval stack underneath was fully working. An admin could upload documents
 * and had no way to check they were actually reachable until a real client
 * email happened to need them.
 *
 * This runs the SAME two halves and the SAME fusion the Matcher node runs, so
 * what the admin sees is what a reply would be grounded in — not a second,
 * lookalike implementation that could drift.
 */
@Injectable()
export class KbSearchService {
  private readonly logger = new Logger(KbSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiModelService: AiModelService,
  ) {}

  async search(tenantId: string, question: string): Promise<KbSearchResult> {
    const startedAt = Date.now();
    const deps = { prisma: this.prisma, aiModelService: this.aiModelService };

    const [semantic, keyword] = await Promise.all([
      semanticSearch(tenantId, question, deps),
      keywordSearch(tenantId, question, this.prisma),
    ]);

    // Deliberately NOT retrieveChunks(). That helper ends with
    // expandNeighbours, which re-sorts everything into document reading order
    // and throws the RRF ranking away — correct when feeding an LLM that
    // should read a procedure in sequence, wrong for a screen whose whole
    // purpose is to show what ranked highest and why.
    const fused = rrfFuse([semantic, keyword]).slice(0, PREVIEW_TOP_K);

    const semanticIds = new Set(semantic.map((c) => c.id));
    const keywordIds = new Set(keyword.map((c) => c.id));

    const hits = await this.withFilenames(
      fused.map((chunk) => ({
        chunk,
        foundBy: foundBy(semanticIds.has(chunk.id), keywordIds.has(chunk.id)),
      })),
    );

    const outcome = await this.classifyOutcome(tenantId, hits);
    const tookMs = Date.now() - startedAt;

    this.logger.log(
      `KB test for tenant ${tenantId}: ${hits.length} hit(s) in ${tookMs}ms (${outcome})`,
    );

    return {
      question,
      outcome,
      tookMs,
      candidates: { semantic: semantic.length, keyword: keyword.length },
      hits,
    };
  }

  /**
   * A chunk knows its document id but not its name, and "doc-4f2a…" means
   * nothing to the person who uploaded "Pricing 2026.pdf". One extra query
   * rather than widening the two hot retrieval queries the reply path shares.
   */
  private async withFilenames(
    scored: { chunk: RetrievedChunk; foundBy: FoundBy }[],
  ): Promise<KbSearchHit[]> {
    if (scored.length === 0) return [];

    const documents = await this.prisma.document.findMany({
      where: {
        id: { in: [...new Set(scored.map((s) => s.chunk.documentId))] },
      },
      select: { id: true, filename: true },
    });
    const nameById = new Map(documents.map((d) => [d.id, d.filename]));

    return scored.map(({ chunk, foundBy: found }) => {
      // The keyword half selects a literal 0 for similarity; reporting that as
      // a real score would make an exact-token match look like a total miss.
      const similarity = found === 'keyword' ? null : chunk.similarity;
      return {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        filename: nameById.get(chunk.documentId) ?? '(deleted document)',
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        similarity,
        strength: strengthOf(similarity, found),
        foundBy: found,
        isLowConfidence: chunk.isLowConfidence,
      };
    });
  }

  /**
   * Four different situations the admin needs told apart, because each calls
   * for a different action:
   *
   *   empty_knowledge_base — nothing indexed. Upload something.
   *   no_match             — documents exist, retrieval returned none.
   *   weak_match           — passages came back, but none of them actually
   *                          answers this. Vector search ALWAYS returns its top
   *                          K, so this is the common case for a question the
   *                          knowledge base does not cover, and the one most
   *                          likely to be misread as success.
   *   ok                   — at least one passage is a real answer.
   *
   * The emptiness query counts EMBEDDED chunks: an unembedded chunk is
   * invisible to the semantic half, so a knowledge base still being indexed
   * genuinely does look empty, and saying so is correct.
   */
  private async classifyOutcome(
    tenantId: string,
    hits: KbSearchHit[],
  ): Promise<KbSearchOutcome> {
    if (hits.some((h) => h.strength !== 'weak')) return 'ok';
    if (hits.length > 0) return 'weak_match';

    const [{ n }] = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n
      FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.tenant_id = ${tenantId}::uuid
        AND c.embedding IS NOT NULL
    `;
    return Number(n) === 0 ? 'empty_knowledge_base' : 'no_match';
  }
}

/**
 * How good a match is, given both what the cosine says and which halves found
 * it.
 *
 * The keyword half matters independently: it fires on a literal token, the
 * exact case embeddings are worst at (SKUs, part codes), so a hit it found is
 * never merely noise. But it is not automatically the best kind of match
 * either — its query is OR over every word, so one shared ordinary word is
 * enough to produce a hit, and calling that "strong" would tell the admin the
 * knowledge base answers something it does not. 'moderate' is the honest floor:
 * a real token matched, and nothing more is claimed.
 *
 * The floor also fixes an incoherence. Strength used to be a function of
 * similarity alone, so a passage found by BOTH halves at cosine 0.2 was labelled
 * 'weak' while the very same passage found by keyword alone was 'strong' —
 * finding it in more places made it look worse.
 */
function strengthOf(similarity: number | null, found: FoundBy): MatchStrength {
  const bySimilarity: MatchStrength =
    similarity === null
      ? 'weak'
      : similarity >= STRONG_SIMILARITY
        ? 'strong'
        : similarity >= MODERATE_SIMILARITY
          ? 'moderate'
          : 'weak';

  if (found === 'semantic') return bySimilarity;
  // Keyword was involved: never below moderate, but the cosine can still raise
  // it when the two halves agree.
  return bySimilarity === 'strong' ? 'strong' : 'moderate';
}

function foundBy(inSemantic: boolean, inKeyword: boolean): FoundBy {
  if (inSemantic && inKeyword) return 'both';
  return inSemantic ? 'semantic' : 'keyword';
}
