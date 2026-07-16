import { Test, TestingModule } from '@nestjs/testing';
import { AttachmentsService } from './attachments.service';
import { AttachmentCacheRepository } from './attachment-cache.repository';
import { GmailClientProvider } from '../emails/gmail-client.provider';
import { LlmClientService } from '../../common/llm/llm-client.service';
import * as pdfParse from 'pdf-parse';

// ── module mocks ────────────────────────────────────────────────────────

// Default: pdf text is long enough (above MIN_PDF_TEXT_LENGTH = 100).
const LONG_PDF_TEXT = 'a'.repeat(150);
const SHORT_PDF_TEXT = 'short';

let mockPdfText = LONG_PDF_TEXT;

jest.mock('pdf-parse', () => {
  return {
    PDFParse: jest.fn().mockImplementation(() => {
      return {
        getText: jest
          .fn()
          .mockImplementation(() => Promise.resolve({ text: mockPdfText })),
        getScreenshot: jest.fn().mockResolvedValue({
          pages: [
            { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), pageNumber: 1 },
          ],
          total: 1,
        }),
        destroy: jest.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

jest.mock('mammoth', () => ({
  extractRawText: jest.fn().mockResolvedValue({ value: 'mocked docx text' }),
}));

jest.mock('exceljs', () => {
  return {
    Workbook: jest.fn().mockImplementation(() => ({
      xlsx: {
        load: jest.fn().mockResolvedValue(undefined),
      },
      eachSheet: jest.fn((callback: (ws: any) => void) => {
        const mockWorksheet = {
          name: 'Sheet1',
          eachRow: jest.fn((rowCallback: (row: any) => void) => {
            rowCallback({ values: [null, 'Name', 'Age'] });
            rowCallback({ values: [null, 'Ahmed', 25] });
          }),
        };
        callback(mockWorksheet);
      }),
    })),
  };
});

jest.mock('jszip', () => {
  const mockZip = {
    files: {
      'ppt/slides/slide1.xml': {
        async: jest
          .fn()
          .mockResolvedValue('<a:t>mocked</a:t><a:t> slide 1</a:t>'),
      },
      'ppt/slides/slide2.xml': {
        async: jest.fn().mockResolvedValue('<a:t>mocked slide 2</a:t>'),
      },
    },
  };
  return {
    loadAsync: jest.fn().mockResolvedValue(mockZip),
  };
});

// ── types ───────────────────────────────────────────────────────────────

type MockGmailApi = {
  users: {
    messages: {
      attachments: {
        get: jest.Mock;
      };
    };
  };
};

type MockAttachmentCache = {
  get: jest.Mock;
  set: jest.Mock;
};

// ── helpers ─────────────────────────────────────────────────────────────

const gmailAttachmentData = (content = 'data') =>
  Buffer.from(content).toString('base64url');

const makeAtt = (
  overrides: Partial<{
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
  }> = {},
) => ({
  filename: 'file.pdf',
  mimeType: 'application/pdf',
  size: 1000,
  attachmentId: 'att-1',
  ...overrides,
});

// ── suite ───────────────────────────────────────────────────────────────

describe('AttachmentsService', () => {
  let service: AttachmentsService;
  let mockGmailApi: MockGmailApi;
  let mockCache: MockAttachmentCache;
  let mockLlm: { analyzeImage: jest.Mock };

  beforeEach(async () => {
    mockPdfText = LONG_PDF_TEXT;

    mockGmailApi = {
      users: {
        messages: {
          attachments: {
            get: jest.fn(),
          },
        },
      },
    };

    const mockProvider = {
      getClientForAccount: jest.fn().mockResolvedValue(mockGmailApi),
    };

    mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };

    mockLlm = {
      analyzeImage: jest.fn().mockResolvedValue('vision extracted text'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttachmentsService,
        { provide: GmailClientProvider, useValue: mockProvider },
        { provide: AttachmentCacheRepository, useValue: mockCache },
        { provide: LlmClientService, useValue: mockLlm },
      ],
    }).compile();

    service = module.get<AttachmentsService>(AttachmentsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── parser unit tests ───────────────────────────────────────────────

  describe('Parsers directly', () => {
    it('should extract readable text from a PDF buffer', async () => {
      const buffer = Buffer.from('dummy pdf content');
      const text = await service.parsePdf(buffer);

      expect(text).toBe(LONG_PDF_TEXT);
      expect(pdfParse.PDFParse).toHaveBeenCalledWith({ data: buffer });
    });

    it('should return a valid base64 string for an image buffer', () => {
      const buffer = Buffer.from('dummy image content');
      const base64 = service.parseImage(buffer);

      expect(base64).toBe(buffer.toString('base64'));
    });

    it('should extract text from docx using mammoth', async () => {
      const buffer = Buffer.from('dummy docx');
      const text = await service.parseDocx(buffer);
      expect(text).toBe('mocked docx text');
    });

    it('should extract structured json from xlsx', async () => {
      const buffer = Buffer.from('dummy xlsx');
      const jsonStr = await service.parseXlsx(buffer);
      expect(JSON.parse(jsonStr)).toEqual({
        Sheet1: [
          ['Name', 'Age'],
          ['Ahmed', 25],
        ],
      });
    });

    it('should extract text with slide numbers from pptx', async () => {
      const buffer = Buffer.from('dummy pptx');
      const text = await service.parsePptx(buffer);
      expect(text).toContain('## Slide 1');
      expect(text).toContain('mocked slide 1');
      expect(text).toContain('## Slide 2');
      expect(text).toContain('mocked slide 2');
    });
  });

  // ── download ────────────────────────────────────────────────────────

  describe('downloadAttachment', () => {
    it('should call Gmail API with correct messageId and attachmentId', async () => {
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: Buffer.from('test data').toString('base64url') },
      });

      const buffer = await service.downloadAttachment(
        'test@example.com',
        'msg-123',
        'att-456',
      );

      expect(mockGmailApi.users.messages.attachments.get).toHaveBeenCalledWith({
        userId: 'me',
        messageId: 'msg-123',
        id: 'att-456',
      });
      expect(buffer.toString('utf-8')).toBe('test data');
    });
  });

  // ── cache layer ─────────────────────────────────────────────────────

  describe('Cache layer', () => {
    it('should return cached result and skip parsing on cache hit', async () => {
      const cached = {
        filename: 'doc.pdf',
        type: 'pdf' as const,
        text: 'cached text',
        skipped: false,
        lowQuality: false,
        fallbackToVision: false,
      };
      mockCache.get.mockResolvedValue(cached);

      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt({ filename: 'doc.pdf' }),
      );

      expect(result).toEqual(cached);
      expect(
        mockGmailApi.users.messages.attachments.get,
      ).not.toHaveBeenCalled();
    });

    it('should parse, cache, and return on cache miss', async () => {
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: gmailAttachmentData() },
      });

      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt(),
      );

      expect(result.skipped).toBe(false);
      expect(mockCache.set).toHaveBeenCalledWith('att-1', result);
    });

    it('should not cache skipped results', async () => {
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt({ size: 15 * 1024 * 1024 }),
      );

      expect(result.skipped).toBe(true);
      expect(mockCache.set).not.toHaveBeenCalled();
    });
  });

  // ── lowQuality + fallbackToVision ───────────────────────────────────

  describe('lowQuality flag on weak PDFs', () => {
    it('should set lowQuality=true and fallbackToVision=true for short PDF text', async () => {
      mockPdfText = SHORT_PDF_TEXT;
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: gmailAttachmentData() },
      });

      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt(),
      );

      expect(result.lowQuality).toBe(true);
      expect(result.fallbackToVision).toBe(true);
      expect(mockLlm.analyzeImage).toHaveBeenCalled();
      expect(result.text).toContain('vision_extracted');
      expect(result.text).toContain('vision extracted text');
    });

    it('should set lowQuality=false for normal PDFs', async () => {
      mockPdfText = LONG_PDF_TEXT;
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: gmailAttachmentData() },
      });

      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt(),
      );

      expect(result.lowQuality).toBe(false);
      expect(result.fallbackToVision).toBe(false);
      expect(mockLlm.analyzeImage).not.toHaveBeenCalled();
    });
  });

  // ── untrusted content wrapping ──────────────────────────────────────

  describe('wrapUntrustedContent', () => {
    beforeEach(() => {
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: gmailAttachmentData() },
      });
    });

    it('should wrap PDF text with source=attachment_text', async () => {
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt(),
      );

      expect(result.text).toContain(
        '<untrusted_content source="attachment_text">',
      );
      expect(result.text).toContain(LONG_PDF_TEXT);
    });

    it('should wrap docx text with source=attachment_text', async () => {
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt({
          filename: 'doc.docx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      );

      expect(result.text).toContain(
        '<untrusted_content source="attachment_text">',
      );
      expect(result.text).toContain('mocked docx text');
    });

    it('should wrap pptx text with source=attachment_text', async () => {
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt({
          filename: 'pres.pptx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        }),
      );

      expect(result.text).toContain(
        '<untrusted_content source="attachment_text">',
      );
      expect(result.text).toContain('## Slide 1');
    });

    it('should NOT wrap xlsx structured data', async () => {
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt({
          filename: 'data.xlsx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      );

      expect(result.structured).toBeDefined();
      expect(result.structured).not.toContain('untrusted_content');
    });
  });

  // ── vision wrapping ─────────────────────────────────────────────────

  describe('Vision output wrapping', () => {
    beforeEach(() => {
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: gmailAttachmentData() },
      });
    });

    it('should call vision on images and wrap output with source=vision_extracted', async () => {
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt({ filename: 'photo.jpg', mimeType: 'image/jpeg' }),
      );

      expect(mockLlm.analyzeImage).toHaveBeenCalled();
      expect(result.text).toContain(
        '<untrusted_content source="vision_extracted">',
      );
      expect(result.text).toContain('vision extracted text');
      expect(result.base64).toBeDefined();
    });

    it('should wrap weak-PDF vision fallback with source=vision_extracted', async () => {
      mockPdfText = SHORT_PDF_TEXT;

      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt(),
      );

      expect(result.text).toContain(
        '<untrusted_content source="vision_extracted">',
      );
    });

    it('should NOT wrap image base64 itself', async () => {
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt({ filename: 'photo.png', mimeType: 'image/png' }),
      );

      expect(result.base64).toBeDefined();
      expect(result.base64).not.toContain('untrusted_content');
    });
  });

  // ── gates & routing (updated for new fields) ───────────────────────

  describe('parseAttachment Gates & Routing', () => {
    it('should skip oversized attachments without calling Gmail API', async () => {
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt({ size: 15 * 1024 * 1024 }),
      );

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('exceeds_size_limit');
      expect(result.lowQuality).toBe(false);
      expect(result.fallbackToVision).toBe(false);
      expect(
        mockGmailApi.users.messages.attachments.get,
      ).not.toHaveBeenCalled();
    });

    it('should route docx correctly', async () => {
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: gmailAttachmentData() },
      });
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt({
          filename: 'doc.docx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      );
      expect(result.type).toBe('docx');
      expect(result.text).toContain('mocked docx text');
      expect(result.skipped).toBe(false);
    });

    it('should route xlsx correctly', async () => {
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: gmailAttachmentData() },
      });
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt({
          filename: 'data.xlsx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      );
      expect(result.type).toBe('xlsx');
      expect(result.structured).toBeDefined();
      expect(result.skipped).toBe(false);
    });

    it('should route pptx correctly', async () => {
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: gmailAttachmentData() },
      });
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt({
          filename: 'pres.pptx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        }),
      );
      expect(result.type).toBe('pptx');
      expect(result.text).toContain('## Slide 1');
      expect(result.skipped).toBe(false);
    });

    it('should handle corrupt docx with parse_error', async () => {
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: gmailAttachmentData() },
      });
      jest
        .spyOn(service, 'parseDocx')
        .mockRejectedValueOnce(new Error('corrupt docx'));

      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt({
          filename: 'doc.docx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      );
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('parse_error');
      expect(result.lowQuality).toBe(false);
    });

    it('should skip unknown formats directly', async () => {
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        makeAtt({ filename: 'archive.zip', mimeType: 'application/zip' }),
      );
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('unsupported_type');
      expect(
        mockGmailApi.users.messages.attachments.get,
      ).not.toHaveBeenCalled();
    });
  });

  // ── batch processing ────────────────────────────────────────────────

  describe('parseAttachments Batch Processing', () => {
    it('should process mixed email (pdf, xlsx, zip) appropriately', async () => {
      const email = {
        id: 'msg-1',
        attachments: [
          makeAtt({ filename: 'doc1.pdf', attachmentId: 'att-1' }),
          makeAtt({
            filename: 'data.xlsx',
            mimeType:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            attachmentId: 'att-2',
          }),
          makeAtt({
            filename: 'archive.zip',
            mimeType: 'application/zip',
            attachmentId: 'att-3',
          }),
        ],
      };

      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: gmailAttachmentData('valid data') },
      });

      const results = await service.parseAttachments('test@example.com', email);

      expect(results).toHaveLength(3);

      expect(results[0].filename).toBe('doc1.pdf');
      expect(results[0].skipped).toBeFalsy();
      expect(results[0].type).toBe('pdf');

      expect(results[1].filename).toBe('data.xlsx');
      expect(results[1].skipped).toBeFalsy();
      expect(results[1].type).toBe('xlsx');
      expect(results[1].structured).toBeDefined();

      expect(results[2].filename).toBe('archive.zip');
      expect(results[2].skipped).toBe(true);
      expect(results[2].reason).toBe('unsupported_type');
    });
  });
});
