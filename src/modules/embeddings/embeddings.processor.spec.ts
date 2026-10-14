import { EmbeddingsProcessor } from './embeddings.processor';
import type { Job } from 'bullmq';
import type { EmbedDocumentJobData } from './embeddings.constants';

// No DB, no Ollama — the queue/DB/AI are stubbed. We test OUR worker logic:
// it loops until no NULL chunks remain, embeds each batch, writes each back,
// and is idempotent (an empty first query does nothing).
function makeJob(documentId: string): Job<EmbedDocumentJobData> {
  return { data: { documentId } } as Job<EmbedDocumentJobData>;
}

describe('EmbeddingsProcessor', () => {
  it('embeds every NULL chunk of the document, then stops', async () => {
    const rows = [
      { id: 'c1', content: 'first' },
      { id: 'c2', content: 'second' },
    ];
    // 1st SELECT returns the two chunks; 2nd returns none → loop ends.
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const embedDocuments = jest.fn().mockResolvedValue([[0.1], [0.2]]);

    const proc = new EmbeddingsProcessor(
      { $queryRaw: queryRaw, $executeRaw: executeRaw } as never,
      { embedDocuments } as never,
      { add: jest.fn().mockResolvedValue({}) } as never,
    );

    const result = await proc.process(makeJob('doc-1'));

    expect(result).toEqual({ embedded: 2 });
    expect(embedDocuments).toHaveBeenCalledWith(['first', 'second']);
    expect(executeRaw).toHaveBeenCalledTimes(2); // one write per chunk
  });

  it('does nothing when the document has no NULL chunks (idempotent re-run)', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const embedDocuments = jest.fn();
    const proc = new EmbeddingsProcessor(
      { $queryRaw: queryRaw, $executeRaw: jest.fn() } as never,
      { embedDocuments } as never,
      { add: jest.fn().mockResolvedValue({}) } as never,
    );

    const result = await proc.process(makeJob('doc-1'));

    expect(result).toEqual({ embedded: 0 });
    expect(embedDocuments).not.toHaveBeenCalled();
  });
});
