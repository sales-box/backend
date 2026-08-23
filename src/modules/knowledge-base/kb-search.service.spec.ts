import { KbSearchService } from './kb-search.service';
import * as matcher from '../ai/graphs/reply/nodes/matcher/matcher.node';

jest.mock('../ai/graphs/reply/nodes/matcher/matcher.node', () => {
  const actual = jest.requireActual<typeof matcher>(
    '../ai/graphs/reply/nodes/matcher/matcher.node',
  );
  return {
    ...actual, // rrfFuse stays REAL — the ranking is what is under test
    semanticSearch: jest.fn(),
    keywordSearch: jest.fn(),
    expandNeighbours: jest.fn(),
  };
});

const semanticSearch = matcher.semanticSearch as jest.Mock;
const keywordSearch = matcher.keywordSearch as jest.Mock;
const expandNeighbours = matcher.expandNeighbours as jest.Mock;

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

const chunk = (over: Partial<matcher.RetrievedChunk> = {}) => ({
  id: 'chunk-1',
  content: 'Lead time is 14 days.',
  chunkIndex: 0,
  documentId: 'doc-1',
  tenantId: TENANT,
  isLowConfidence: false,
  similarity: 0.9,
  ...over,
});

function make(documents: { id: string; filename: string }[] = []) {
  const prisma = {
    document: { findMany: jest.fn().mockResolvedValue(documents) },
    $queryRaw: jest.fn().mockResolvedValue([{ n: 0n }]),
  };
  const ai = { embedQuery: jest.fn() };
  return {
    prisma,
    service: new KbSearchService(prisma as never, ai as never),
  };
}

describe('KbSearchService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    semanticSearch.mockResolvedValue([]);
    keywordSearch.mockResolvedValue([]);
  });

  it('never calls expandNeighbours — it would destroy the ranking', async () => {
    // expandNeighbours re-sorts into document reading order, discarding the RRF
    // ranking. That is right for feeding an LLM a procedure in sequence and
    // wrong for a screen whose entire purpose is to show what ranked highest.
    semanticSearch.mockResolvedValue([chunk()]);
    const { service } = make([{ id: 'doc-1', filename: 'Pricing.pdf' }]);

    await service.search(TENANT, 'lead time?');

    expect(expandNeighbours).not.toHaveBeenCalled();
  });

  it('ranks a chunk found by BOTH halves above one found by a single half', async () => {
    // The real rrfFuse decides this; the test pins the property, not the maths.
    const both = chunk({ id: 'both', documentId: 'doc-1' });
    const semOnly = chunk({ id: 'sem-only', documentId: 'doc-1' });
    const kwOnly = chunk({ id: 'kw-only', documentId: 'doc-1', similarity: 0 });
    semanticSearch.mockResolvedValue([semOnly, both]);
    keywordSearch.mockResolvedValue([kwOnly, both]);
    const { service } = make([{ id: 'doc-1', filename: 'Pricing.pdf' }]);

    const res = await service.search(TENANT, 'lead time?');

    expect(res.hits[0].chunkId).toBe('both');
    expect(res.hits[0].foundBy).toBe('both');
  });

  it('labels which half found each passage', async () => {
    semanticSearch.mockResolvedValue([chunk({ id: 'a' })]);
    keywordSearch.mockResolvedValue([chunk({ id: 'b', similarity: 0 })]);
    const { service } = make([{ id: 'doc-1', filename: 'Pricing.pdf' }]);

    const res = await service.search(TENANT, 'WP-120');

    expect(new Map(res.hits.map((h) => [h.chunkId, h.foundBy]))).toEqual(
      new Map([
        ['a', 'semantic'],
        ['b', 'keyword'],
      ]),
    );
  });

  it('reports no similarity for a keyword-only hit rather than zero', async () => {
    // The keyword SQL selects a literal 0. Showing that as a score would make
    // an exact-token match look like a total miss.
    keywordSearch.mockResolvedValue([chunk({ id: 'kw', similarity: 0 })]);
    const { service } = make([{ id: 'doc-1', filename: 'Pricing.pdf' }]);

    const res = await service.search(TENANT, 'WP-120');

    expect(res.hits[0].similarity).toBeNull();
  });

  it('resolves the document name — an id means nothing to the admin', async () => {
    semanticSearch.mockResolvedValue([chunk({ documentId: 'doc-9' })]);
    const { service } = make([{ id: 'doc-9', filename: 'Pricing 2026.pdf' }]);

    const res = await service.search(TENANT, 'price?');

    expect(res.hits[0].filename).toBe('Pricing 2026.pdf');
  });

  it('survives a document deleted between retrieval and naming', async () => {
    semanticSearch.mockResolvedValue([chunk({ documentId: 'gone' })]);
    const { service } = make([]); // findMany returns nothing

    const res = await service.search(TENANT, 'price?');

    expect(res.hits[0].filename).toBe('(deleted document)');
  });

  it('distinguishes an empty knowledge base from one that simply missed', async () => {
    // Two different problems: one needs an upload, the other needs a better
    // document. "No results" for both leaves the admin guessing.
    const { service, prisma } = make([]);
    prisma.$queryRaw.mockResolvedValue([{ n: 0n }]);
    expect((await service.search(TENANT, 'anything')).outcome).toBe(
      'empty_knowledge_base',
    );

    prisma.$queryRaw.mockResolvedValue([{ n: 42n }]);
    expect((await service.search(TENANT, 'anything')).outcome).toBe('no_match');
  });

  it('does not run the emptiness query when there are hits', async () => {
    semanticSearch.mockResolvedValue([chunk()]);
    const { service, prisma } = make([{ id: 'doc-1', filename: 'a.pdf' }]);

    const res = await service.search(TENANT, 'lead time?');

    expect(res.outcome).toBe('ok');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  describe('match strength', () => {
    // Verified live against a real corpus: a genuine answer scores ~0.5+ while
    // an unrelated question ("do you sell submarines?" against a pump
    // catalogue) still returns three passages at ~0.18-0.22. Without a label
    // the admin reads those three as coverage they do not have.
    it.each([
      [0.9, 'strong'],
      [0.45, 'strong'],
      [0.44, 'moderate'],
      [0.3, 'moderate'],
      [0.29, 'weak'],
      [0.05, 'weak'],
    ])('similarity %p is %s', async (similarity, expected) => {
      semanticSearch.mockResolvedValue([chunk({ similarity })]);
      const { service } = make([{ id: 'doc-1', filename: 'a.pdf' }]);

      const res = await service.search(TENANT, 'q');

      expect(res.hits[0].strength).toBe(expected);
    });

    it('treats a keyword-only hit as strong despite having no score', async () => {
      // A literal token match is the case embeddings are WORST at — SKUs, part
      // numbers. Calling "no similarity" weak would bury the best kind of hit.
      keywordSearch.mockResolvedValue([chunk({ id: 'kw', similarity: 0 })]);
      const { service } = make([{ id: 'doc-1', filename: 'a.pdf' }]);

      const res = await service.search(TENANT, 'WP-120');

      expect(res.hits[0]).toMatchObject({
        similarity: null,
        strength: 'strong',
      });
    });

    it('says weak_match when passages came back but none of them answers', async () => {
      semanticSearch.mockResolvedValue([
        chunk({ id: 'a', similarity: 0.21 }),
        chunk({ id: 'b', similarity: 0.19 }),
      ]);
      const { service, prisma } = make([{ id: 'doc-1', filename: 'a.pdf' }]);

      const res = await service.search(TENANT, 'do you sell submarines?');

      expect(res.outcome).toBe('weak_match');
      expect(res.hits).toHaveLength(2); // still shown — this screen shows the truth
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('one real answer among weak ones is still ok', async () => {
      semanticSearch.mockResolvedValue([
        chunk({ id: 'good', similarity: 0.55 }),
        chunk({ id: 'noise', similarity: 0.12 }),
      ]);
      const { service } = make([{ id: 'doc-1', filename: 'a.pdf' }]);

      expect((await service.search(TENANT, 'q')).outcome).toBe('ok');
    });
  });

  it('reports what each half contributed', async () => {
    semanticSearch.mockResolvedValue([chunk({ id: 'a' }), chunk({ id: 'b' })]);
    keywordSearch.mockResolvedValue([chunk({ id: 'c', similarity: 0 })]);
    const { service } = make([{ id: 'doc-1', filename: 'a.pdf' }]);

    const res = await service.search(TENANT, 'q');

    expect(res.candidates).toEqual({ semantic: 2, keyword: 1 });
  });

  it('carries the extraction warning through to the hit', async () => {
    semanticSearch.mockResolvedValue([chunk({ isLowConfidence: true })]);
    const { service } = make([{ id: 'doc-1', filename: 'scan.pdf' }]);

    const res = await service.search(TENANT, 'q');

    expect(res.hits[0].isLowConfidence).toBe(true);
  });

  it('runs both halves concurrently against the same tenant', async () => {
    const { service, prisma } = make([]);
    await service.search(TENANT, 'a question');

    expect(semanticSearch).toHaveBeenCalledWith(
      TENANT,
      'a question',
      expect.objectContaining({ prisma }),
    );
    expect(keywordSearch).toHaveBeenCalledWith(TENANT, 'a question', prisma);
  });
});
