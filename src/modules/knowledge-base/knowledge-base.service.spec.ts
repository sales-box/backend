import { BadRequestException } from '@nestjs/common';
import { DocumentStatus } from '@prisma/client';
import { KnowledgeBaseService } from './knowledge-base.service';
import { PrismaService } from '../../database/prisma.service';

describe('KnowledgeBaseService', () => {
  let service: KnowledgeBaseService;
  let tx: {
    document: { deleteMany: jest.Mock; create: jest.Mock };
    documentChunk: { createMany: jest.Mock };
  };
  let prisma: { $transaction: jest.Mock };

  beforeEach(() => {
    tx = {
      document: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'doc-1' }),
      },
      documentChunk: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma = {
      $transaction: jest
        .fn()
        .mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    service = new KnowledgeBaseService(prisma as unknown as PrismaService);
  });

  it('rejects unsupported file types with 400 and writes nothing', async () => {
    await expect(
      service.ingest({
        filename: 'malware.exe',
        mimetype: 'application/octet-stream',
        buffer: Buffer.from('MZ'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('chunks a .txt file and stores chunks (chunksCreated > 0)', async () => {
    const content = 'Sales pricing details for the enterprise plan. '.repeat(
      500,
    );
    const res = await service.ingest({
      filename: 'pricing.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from(content, 'utf-8'),
    });

    expect(res.status).toBe(DocumentStatus.completed);
    expect(res.chunksCreated).toBeGreaterThan(0);
    expect(res.filename).toBe('pricing.txt');
    expect(tx.documentChunk.createMany).toHaveBeenCalledTimes(1);

    const calls = tx.documentChunk.createMany.mock.calls as Array<
      [
        {
          data: Array<{
            documentId: string;
            chunkIndex: number;
            content: string;
          }>;
        },
      ]
    >;
    const arg = calls[0][0];
    expect(arg.data).toHaveLength(res.chunksCreated);
    expect(arg.data[0]).toMatchObject({ documentId: 'doc-1', chunkIndex: 0 });
  });

  it('replaces prior chunks for the same filename (deleteMany by filename)', async () => {
    await service.ingest({
      filename: 'pricing.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('hello world', 'utf-8'),
    });
    expect(tx.document.deleteMany).toHaveBeenCalledWith({
      where: { filename: 'pricing.txt' },
    });
  });

  it('marks empty content as failed with zero chunks', async () => {
    const res = await service.ingest({
      filename: 'empty.md',
      mimetype: 'text/markdown',
      buffer: Buffer.from('   ', 'utf-8'),
    });
    expect(res.chunksCreated).toBe(0);
    expect(res.status).toBe(DocumentStatus.failed);
    expect(tx.documentChunk.createMany).not.toHaveBeenCalled();
  });
});
