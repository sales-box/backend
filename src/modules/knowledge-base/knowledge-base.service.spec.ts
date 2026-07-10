import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DocumentStatus } from '@prisma/client';
import { KnowledgeBaseService } from './knowledge-base.service';
import { PrismaService } from '../../database/prisma.service';

// The PDF path is only exercised by the corrupt-PDF test below.
jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({
    getText: jest.fn().mockRejectedValue(new Error('bad xref table')),
  })),
}));

describe('KnowledgeBaseService', () => {
  let service: KnowledgeBaseService;
  let tx: {
    document: { deleteMany: jest.Mock; create: jest.Mock };
    documentChunk: { createMany: jest.Mock };
  };
  let paginate: jest.Mock;
  let deleteDocMany: jest.Mock;
  let prisma: {
    $transaction: jest.Mock;
    document: { deleteMany: jest.Mock };
    extended: { document: { paginate: jest.Mock } };
  };

  beforeEach(() => {
    tx = {
      document: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'doc-1' }),
      },
      documentChunk: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    paginate = jest.fn();
    deleteDocMany = jest.fn();
    prisma = {
      $transaction: jest
        .fn()
        .mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
      document: { deleteMany: deleteDocMany },
      extended: { document: { paginate } },
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

  describe('assessDocumentQuality (quality gate, S3-V20)', () => {
    it('flags zero chunks as low confidence', () => {
      const q = service.assessDocumentQuality(0, 1024, 0);
      expect(q).toEqual({
        isLowConfidence: true,
        qualityReason: 'No extractable text found',
      });
    });

    it('flags very little extracted text', () => {
      const q = service.assessDocumentQuality(42, 1024, 1);
      expect(q.isLowConfidence).toBe(true);
      expect(q.qualityReason).toContain('42 characters');
    });

    it('flags a scanned-PDF profile: big file, tiny text ratio', () => {
      // 5MB file, 300 chars of text → ratio far below threshold.
      const q = service.assessDocumentQuality(300, 5 * 1024 * 1024, 1);
      expect(q.isLowConfidence).toBe(true);
      expect(q.qualityReason).toContain('scanned');
    });

    it('passes a healthy text document', () => {
      const q = service.assessDocumentQuality(10_000, 20_000, 12);
      expect(q).toEqual({ isLowConfidence: false, qualityReason: null });
    });
  });

  it('upload response carries the quality warning immediately (S3-V20)', async () => {
    const res = await service.ingest({
      filename: 'tiny.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('barely any text here', 'utf-8'),
    });

    expect(res.isLowConfidence).toBe(true);
    expect(res.qualityReason).toContain('characters');
    const createArg = (
      tx.document.create.mock.calls as Array<[unknown]>
    )[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data.isLowConfidence).toBe(true);
  });

  it('healthy upload is not flagged by the quality gate', async () => {
    const content = 'Sales pricing details for the enterprise plan. '.repeat(
      500,
    );
    const res = await service.ingest({
      filename: 'pricing.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from(content, 'utf-8'),
    });

    expect(res.isLowConfidence).toBe(false);
    expect(res.qualityReason).toBeUndefined();
  });

  it('rejects a corrupt PDF with 400 and writes nothing', async () => {
    await expect(
      service.ingest({
        filename: 'broken.pdf',
        mimetype: 'application/pdf',
        buffer: Buffer.from('not really a pdf'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
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

  describe('listDocuments', () => {
    it('returns the paginated result, newest first, selecting only list fields', async () => {
      const page = {
        data: [
          {
            id: 'doc-1',
            filename: 'pricing.pdf',
            fileType: 'pdf',
            status: DocumentStatus.completed,
            chunkCount: 12,
            uploadDate: new Date('2026-07-01T00:00:00.000Z'),
            processingError: null,
          },
        ],
        meta: {
          total: 1,
          lastPage: 1,
          currentPage: 2,
          limit: 5,
          prev: 1,
          next: null,
        },
      };
      paginate.mockResolvedValue(page);

      const res = await service.listDocuments({ page: 2, limit: 5 });

      expect(res).toBe(page);
      expect(paginate).toHaveBeenCalledTimes(1);
      const [args, options] = paginate.mock.calls[0] as [
        { select: Record<string, boolean>; orderBy: unknown },
        unknown,
      ];
      expect(args.orderBy).toEqual({ uploadDate: 'desc' });
      expect(args.select).toEqual({
        id: true,
        filename: true,
        fileType: true,
        status: true,
        chunkCount: true,
        uploadDate: true,
        processingError: true,
        isLowConfidence: true,
        qualityReason: true,
      });
      expect(options).toEqual({ page: 2, limit: 5 });
    });
  });

  describe('deleteDocument', () => {
    it('deletes by id and resolves; chunks are removed by the FK cascade', async () => {
      deleteDocMany.mockResolvedValue({ count: 1 });

      await expect(service.deleteDocument('doc-1')).resolves.toBeUndefined();
      expect(deleteDocMany).toHaveBeenCalledWith({ where: { id: 'doc-1' } });
    });

    it('throws NotFoundException when no document matches the id', async () => {
      deleteDocMany.mockResolvedValue({ count: 0 });

      await expect(service.deleteDocument('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
