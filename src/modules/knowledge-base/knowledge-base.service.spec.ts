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

jest.mock('mammoth', () => ({
  extractRawText: jest.fn().mockResolvedValue({
    value: 'Docx extracted text content for testing purposes.',
  }),
}));

const mockEachRow = jest.fn((cb: (row: { values: unknown[] }) => void) => {
  cb({ values: [null, 'Name', 'Price', 'SKU'] });
  cb({ values: [null, 'Widget', '9.99', 'W-001'] });
});
const mockEachSheet = jest.fn(
  (cb: (ws: { name: string; eachRow: typeof mockEachRow }) => void) => {
    cb({ name: 'Sheet1', eachRow: mockEachRow });
  },
);
jest.mock('exceljs', () => ({
  Workbook: jest.fn().mockImplementation(() => ({
    xlsx: {
      load: jest.fn().mockResolvedValue(undefined),
    },
    eachSheet: mockEachSheet,
  })),
}));

jest.mock('jszip', () => ({
  __esModule: true,
  default: {
    loadAsync: jest.fn().mockResolvedValue({
      files: {
        'ppt/slides/slide1.xml': {
          async: jest
            .fn()
            .mockResolvedValue(
              '<a:t>Hello World</a:t><a:t>Slide content</a:t>',
            ),
        },
        'ppt/slides/slide2.xml': {
          async: jest.fn().mockResolvedValue('<a:t>Second slide text</a:t>'),
        },
      },
    }),
  },
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
      where: { filename: 'pricing.txt', tenantId: null },
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

  it('ingests a .docx file using mammoth', async () => {
    const res = await service.ingest({
      filename: 'proposal.docx',
      mimetype:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('fake-docx'),
    });
    expect(res.status).toBe(DocumentStatus.completed);
    expect(res.chunksCreated).toBeGreaterThan(0);
    expect(res.filename).toBe('proposal.docx');
  });

  it('ingests a .xlsx file using ExcelJS', async () => {
    const res = await service.ingest({
      filename: 'catalog.xlsx',
      mimetype:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from('fake-xlsx'),
    });
    expect(res.status).toBe(DocumentStatus.completed);
    expect(res.chunksCreated).toBeGreaterThan(0);
    expect(res.filename).toBe('catalog.xlsx');
  });

  it('ingests a .pptx file using JSZip', async () => {
    const res = await service.ingest({
      filename: 'deck.pptx',
      mimetype:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: Buffer.from('fake-pptx'),
    });
    expect(res.status).toBe(DocumentStatus.completed);
    expect(res.chunksCreated).toBeGreaterThan(0);
    expect(res.filename).toBe('deck.pptx');
  });

  it('maps .ppt extension to pptx parser', async () => {
    const res = await service.ingest({
      filename: 'legacy.ppt',
      mimetype: 'application/vnd.ms-powerpoint',
      buffer: Buffer.from('fake-ppt'),
    });
    expect(res.status).toBe(DocumentStatus.completed);
    expect(res.filename).toBe('legacy.ppt');
  });

  it('rejects a corrupt DOCX with 400', async () => {
    const mammoth: { extractRawText: jest.Mock } = jest.requireMock('mammoth');
    mammoth.extractRawText.mockRejectedValueOnce(new Error('corrupt zip'));
    await expect(
      service.ingest({
        filename: 'bad.docx',
        mimetype: 'application/octet-stream',
        buffer: Buffer.from('garbage'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a corrupt XLSX with 400', async () => {
    const ExcelJS: { Workbook: jest.Mock } = jest.requireMock('exceljs');
    ExcelJS.Workbook.mockImplementationOnce(() => ({
      xlsx: { load: jest.fn().mockRejectedValue(new Error('bad xlsx')) },
      eachSheet: jest.fn(),
    }));
    await expect(
      service.ingest({
        filename: 'bad.xlsx',
        mimetype: 'application/octet-stream',
        buffer: Buffer.from('garbage'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a corrupt PPTX with 400', async () => {
    const jszip: { default: { loadAsync: jest.Mock } } =
      jest.requireMock('jszip');
    jszip.default.loadAsync.mockRejectedValueOnce(new Error('bad zip'));
    await expect(
      service.ingest({
        filename: 'bad.pptx',
        mimetype: 'application/octet-stream',
        buffer: Buffer.from('garbage'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
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

      const res = await service.listDocuments(
        { page: 2, limit: 5 },
        'tenant-a',
      );

      expect(res).toBe(page);
      expect(paginate).toHaveBeenCalledTimes(1);
      const [args, options] = paginate.mock.calls[0] as [
        {
          where: Record<string, unknown>;
          select: Record<string, boolean>;
          orderBy: unknown;
        },
        unknown,
      ];
      expect(args.where).toEqual({ tenantId: 'tenant-a' });
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

    it('scopes the list to NULL tenant for legacy admins', async () => {
      paginate.mockResolvedValue({ data: [], meta: {} });
      await service.listDocuments({ page: 1, limit: 20 });
      const [args] = paginate.mock.calls[0] as [{ where: unknown }];
      expect(args.where).toEqual({ tenantId: null });
    });
  });

  describe('deleteDocument', () => {
    it('deletes the tenant own document and resolves (FK cascade removes chunks)', async () => {
      deleteDocMany.mockResolvedValue({ count: 1 });

      await expect(
        service.deleteDocument('doc-1', 'tenant-a'),
      ).resolves.toBeUndefined();
      expect(deleteDocMany).toHaveBeenCalledWith({
        where: { id: 'doc-1', tenantId: 'tenant-a' },
      });
    });

    it('throws NotFoundException when no document matches id + tenant', async () => {
      deleteDocMany.mockResolvedValue({ count: 0 });

      await expect(
        service.deleteDocument('missing', 'tenant-a'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
