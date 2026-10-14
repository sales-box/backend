/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { QualityProcessor } from './quality.processor';
import { computeRedundancy } from './dedup';

jest.mock('./dedup');

function makePrisma(chunks: { content: string }[]) {
  return {
    document: {
      findUnique: jest.fn().mockResolvedValue({ id: 'doc-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    documentChunk: { findMany: jest.fn().mockResolvedValue(chunks) },
  } as never;
}

describe('QualityProcessor', () => {
  it('writes coverage score + redundancy into the document', async () => {
    (computeRedundancy as jest.Mock).mockResolvedValue({
      duplicateChunkPairs: 0,
      redundancyRatio: 0,
      concisenessScore: 100,
    });
    const prisma = makePrisma([
      { content: 'price $4,200 flow 55 m³/h designed for dewatering' },
    ]);
    const proc = new QualityProcessor(prisma);
    await proc.process({ data: { documentId: 'doc-1' } } as never);

    const arg = (prisma as { document: { update: jest.Mock } }).document.update
      .mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'doc-1' });
    expect(typeof arg.data.qualityScore).toBe('number');
    expect(arg.data.qualityReport.concisenessScore).toBe(100);
    expect(arg.data.qualityReport.passed).toContain('price');
  });

  it('skips a document that no longer exists', async () => {
    const prisma = makePrisma([]);
    (
      prisma as { document: { findUnique: jest.Mock } }
    ).document.findUnique.mockResolvedValue(null);
    const proc = new QualityProcessor(prisma);
    await proc.process({ data: { documentId: 'gone' } } as never);
    expect(
      (prisma as { document: { update: jest.Mock } }).document.update,
    ).not.toHaveBeenCalled();
  });
});
