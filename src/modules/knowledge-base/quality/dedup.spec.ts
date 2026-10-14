import { computeRedundancy } from './dedup';

function fakePrisma(pairRows: unknown, totalRows: unknown) {
  return {
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce(pairRows) // duplicate pairs
      .mockResolvedValueOnce(totalRows), // chunk count
  } as never;
}

describe('computeRedundancy', () => {
  it('derives ratio + conciseness from duplicate pairs and chunk count', async () => {
    const prisma = fakePrisma([{ pairs: 2n }], [{ n: 10n }]);
    const r = await computeRedundancy(prisma, 'doc-1');
    expect(r.duplicateChunkPairs).toBe(2);
    expect(r.redundancyRatio).toBeCloseTo(0.2);
    expect(r.concisenessScore).toBe(80);
  });
  it('is safe when a document has 0 or 1 chunks', async () => {
    const prisma = fakePrisma([{ pairs: 0n }], [{ n: 1n }]);
    const r = await computeRedundancy(prisma, 'doc-1');
    expect(r.redundancyRatio).toBe(0);
    expect(r.concisenessScore).toBe(100);
  });
});
