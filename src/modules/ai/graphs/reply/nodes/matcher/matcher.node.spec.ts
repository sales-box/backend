import {
  retrieveChunks,
  expandNeighbours,
  rrfFuse,
  routeByIntent,
  matcherNode,
  RetrievedChunk,
} from './matcher.node';
import { AnswerSchema, RecommendationSchema } from './matcher.schema';
import type { ReplyGraphStateType } from '../../reply-graph.state';

// CI has no Ollama, no LLM provider, no database. Everything external is
// stubbed: the tests exercise OUR logic (walls, guards, router, fusion) —
// a test that hits the network is a flaky integration test in a costume.
const FAKE_VECTOR = [0.1, 0.2, 0.3]; // the tests need *a* vector, not a meaningful one

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function chunk(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    id: 'chunk-1',
    content: 'some product text',
    chunkIndex: 0,
    documentId: 'doc-1',
    tenantId: TENANT_A,
    isLowConfidence: false,
    similarity: 0.9,
    ...over,
  };
}

function makeDeps(rows: RetrievedChunk[] = []) {
  return {
    prisma: { $queryRaw: jest.fn().mockResolvedValue(rows) },
    aiModelService: {
      embedQuery: jest.fn().mockResolvedValue(FAKE_VECTOR),
      // Typed so tests can inspect which schema each call used.
      generateStructured: jest.fn<Promise<unknown>, [{ schema: unknown }]>(),
    },
  };
}

function makeState(
  over: Partial<ReplyGraphStateType> = {},
): ReplyGraphStateType {
  return {
    connectedAccountId: 'account-1',
    threadId: 'thread-1',
    messageId: 'message-1',
    emailId: 'email-1',
    tenantId: TENANT_A,
    emailBody: 'we need a pump for outdoor use',
    intent: undefined,
    requirements: undefined,
    matchResult: undefined,
    composerResult: undefined,
    finalDraft: undefined,
    excludedByUser: [],
    attachmentsText: [],
    externalContentText: [],
    extractorResult: undefined,
    ...over,
  };
}

describe('retrieveChunks — tenant isolation', () => {
  it('throws when tenantId is missing, before any DB call', async () => {
    const deps = makeDeps();
    await expect(retrieveChunks('', 'query', deps as never)).rejects.toThrow(
      /tenantId is missing/,
    );
    expect(deps.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('wall 2: throws when a foreign-tenant row appears in results', async () => {
    // Simulates the day someone breaks wall 1 (the SQL filter) in a
    // refactor: the query "returns" a row owned by another tenant.
    const deps = makeDeps([chunk({ tenantId: TENANT_B })]);
    await expect(
      retrieveChunks(TENANT_A, 'query', deps as never),
    ).rejects.toThrow(/cross-tenant/);
  });

  it('returns only own-tenant rows when the query behaves', async () => {
    const deps = makeDeps([chunk(), chunk({ id: 'chunk-2', chunkIndex: 1 })]);
    const rows = await retrieveChunks(TENANT_A, 'query', deps as never);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === TENANT_A)).toBe(true);
  });
});

describe('routeByIntent', () => {
  it.each([
    ['product inquiry', 'recommendation'],
    ['demo request', 'recommendation'],
    ['support', 'answer'],
    ['follow-up', 'answer'],
    ['sensitive', 'answer'],
    [undefined, 'recommendation'],
  ] as const)('%s → %s', (intent, path) => {
    expect(routeByIntent(intent)).toBe(path);
  });
});

describe('rrfFuse', () => {
  it('a chunk ranked in BOTH lists beats a single-list #1', () => {
    const both = chunk({ id: 'both' });
    const semOnly = chunk({ id: 'sem-only' });
    const kwOnly = chunk({ id: 'kw-only', similarity: 0 });
    // 'both' is ranked #2 in each list; the #1s appear once each.
    const fused = rrfFuse([
      [semOnly, both],
      [kwOnly, both],
    ]);
    expect(fused[0].id).toBe('both'); // 1/62 + 1/62 > 1/61
  });

  it('merges duplicates instead of returning them twice', () => {
    const a = chunk({ id: 'a' });
    const fused = rrfFuse([[a], [chunk({ id: 'a', similarity: 0 })]]);
    expect(fused).toHaveLength(1);
    expect(fused[0].similarity).toBe(0.9); // keeps the semantic instance
  });
});

describe('expandNeighbours', () => {
  it('fetches page-neighbours, dedupes, and sorts into reading order', async () => {
    const hit = chunk({ id: 'mid', chunkIndex: 1 });
    const neighbour = chunk({ id: 'first', chunkIndex: 0, similarity: 0 });
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([neighbour, hit]) };
    const out = await expandNeighbours([hit], TENANT_A, prisma as never);
    expect(out.map((c) => c.id)).toEqual(['first', 'mid']); // reading order
  });
});

describe('matcherNode', () => {
  it('zero chunks → confidence-0 result and the LLM is NEVER called', async () => {
    const deps = makeDeps([]);
    const out = await matcherNode(makeState(), deps as never);
    expect(out.matchResult?.confidence).toBe(0);
    expect(out.matchResult?.recommendedProduct).toBeNull();
    expect(deps.aiModelService.generateStructured).not.toHaveBeenCalled();
  });

  it('recommendation path: drops invented citation IDs, keeps real ones', async () => {
    const deps = makeDeps([chunk({ id: 'real-id' })]);
    deps.aiModelService.generateStructured.mockResolvedValue({
      recommendedProduct: 'Pump X200',
      reasoning: 'fits',
      confidence: 0.8,
      citedChunks: ['real-id', 'invented-id'],
      exclusions: [],
    });
    const out = await matcherNode(makeState(), deps as never);
    expect(out.matchResult?.citedChunks).toEqual(['real-id']);
    expect(out.matchResult?.resultType).toBe('recommendation');
    const call = deps.aiModelService.generateStructured.mock.calls[0][0];
    expect(call.schema).toBe(RecommendationSchema);
  });

  it('computes basedOnLowConfidenceSource from the DB flag, not the model', async () => {
    const deps = makeDeps([chunk({ id: 'flagged', isLowConfidence: true })]);
    deps.aiModelService.generateStructured.mockResolvedValue({
      recommendedProduct: 'Pump X200',
      reasoning: 'fits',
      confidence: 0.8,
      citedChunks: ['flagged'],
      exclusions: [],
    });
    const out = await matcherNode(makeState(), deps as never);
    expect(out.matchResult?.basedOnLowConfidenceSource).toBe(true);
  });

  it('answer path (intent=support): uses AnswerSchema, product is null', async () => {
    const deps = makeDeps([chunk()]);
    deps.aiModelService.generateStructured.mockResolvedValue({
      reasoning: 'the docs say yes',
      confidence: 0.9,
      citedChunks: ['chunk-1'],
    });
    const out = await matcherNode(
      makeState({ intent: 'support' }),
      deps as never,
    );
    expect(out.matchResult?.resultType).toBe('answer');
    expect(out.matchResult?.recommendedProduct).toBeNull();
    const call = deps.aiModelService.generateStructured.mock.calls[0][0];
    expect(call.schema).toBe(AnswerSchema);
  });

  it('exclusion guard: a disobedient model gets caught', async () => {
    const deps = makeDeps([chunk()]);
    deps.aiModelService.generateStructured.mockResolvedValue({
      recommendedProduct: 'Pump X200', // the model recommends it anyway
      reasoning: 'best fit',
      confidence: 0.9,
      citedChunks: ['chunk-1'],
      exclusions: [],
    });
    const out = await matcherNode(
      makeState({ excludedByUser: ['pump x200'] }), // case-insensitive
      deps as never,
    );
    expect(out.matchResult?.recommendedProduct).toBeNull();
    expect(out.matchResult?.confidence).toBe(0);
    expect(out.matchResult?.exclusions).toEqual([
      { product: 'Pump X200', reason: 'Excluded by the user' },
    ]);
  });
});
