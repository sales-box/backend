import { Test, TestingModule } from '@nestjs/testing';
import { AttachmentsService } from './attachments.service';
import { AttachmentCacheRepository } from './attachment-cache.repository';
import { GmailClientProvider } from '../emails/gmail-client.provider';
import * as pdfParse from 'pdf-parse';

// Mock pdf-parse module completely
jest.mock('pdf-parse', () => {
  return {
    PDFParse: jest.fn().mockImplementation(() => {
      return {
        getText: jest.fn().mockResolvedValue({ text: 'mocked pdf text' }),
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

describe('AttachmentsService', () => {
  let service: AttachmentsService;
  let mockGmailApi: MockGmailApi;
  let mockCache: MockAttachmentCache;

  beforeEach(async () => {
    // Basic mock structure for Gmail API
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

    // Default: always a cache miss; individual tests override.
    mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttachmentsService,
        { provide: GmailClientProvider, useValue: mockProvider },
        { provide: AttachmentCacheRepository, useValue: mockCache },
      ],
    }).compile();

    service = module.get<AttachmentsService>(AttachmentsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Parsers directly', () => {
    it('1. should extract readable text from a PDF buffer', async () => {
      const buffer = Buffer.from('dummy pdf content');
      const text = await service.parsePdf(buffer);

      expect(text).toBe('mocked pdf text');
      expect(pdfParse.PDFParse).toHaveBeenCalledWith({ data: buffer });
    });

    it('2. should return a valid base64 string for an image buffer', () => {
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

  describe('parseAttachment Gates & Routing', () => {
    it('should skip oversized attachments without calling Gmail API', async () => {
      const oversizedAtt = {
        filename: 'huge_presentation.pdf',
        mimeType: 'application/pdf',
        size: 15 * 1024 * 1024,
        attachmentId: 'att-123',
      };

      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        oversizedAtt,
      );

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('exceeds_size_limit');
      expect(
        mockGmailApi.users.messages.attachments.get,
      ).not.toHaveBeenCalled();
    });

    it('should route docx correctly', async () => {
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: Buffer.from('data').toString('base64url') },
      });
      const att = {
        filename: 'doc.docx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 1000,
        attachmentId: 'att-1',
      };
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        att,
      );
      expect(result.type).toBe('docx');
      expect(result.text).toBe('mocked docx text');
      expect(result.skipped).toBe(false);
    });

    it('should route xlsx correctly', async () => {
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: Buffer.from('data').toString('base64url') },
      });
      const att = {
        filename: 'data.xlsx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 1000,
        attachmentId: 'att-1',
      };
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        att,
      );
      expect(result.type).toBe('xlsx');
      expect(result.structured).toBeDefined();
      expect(result.skipped).toBe(false);
    });

    it('should route pptx correctly', async () => {
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: Buffer.from('data').toString('base64url') },
      });
      const att = {
        filename: 'pres.pptx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: 1000,
        attachmentId: 'att-1',
      };
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        att,
      );
      expect(result.type).toBe('pptx');
      expect(result.text).toContain('## Slide 1');
      expect(result.skipped).toBe(false);
    });

    it('should handle corrupt docx with parse_error', async () => {
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: Buffer.from('data').toString('base64url') },
      });
      jest
        .spyOn(service, 'parseDocx')
        .mockRejectedValueOnce(new Error('corrupt docx'));

      const att = {
        filename: 'doc.docx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 1000,
        attachmentId: 'att-1',
      };
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        att,
      );
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('parse_error');
    });

    it('should skip unknown formats directly', async () => {
      const att = {
        filename: 'archive.zip',
        mimeType: 'application/zip',
        size: 1000,
        attachmentId: 'att-1',
      };
      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        att,
      );
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('unsupported_type');
      expect(
        mockGmailApi.users.messages.attachments.get,
      ).not.toHaveBeenCalled();
    });
  });

  describe('parseAttachments Batch Processing', () => {
    it('should process mixed email (pdf, xlsx, zip) appropriately', async () => {
      const email = {
        id: 'msg-1',
        attachments: [
          {
            filename: 'doc1.pdf',
            mimeType: 'application/pdf',
            size: 1000,
            attachmentId: 'att-1',
          },
          {
            filename: 'data.xlsx',
            mimeType:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 1000,
            attachmentId: 'att-2',
          },
          {
            filename: 'archive.zip',
            mimeType: 'application/zip',
            size: 1000,
            attachmentId: 'att-3',
          },
        ],
      };

      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: Buffer.from('valid data').toString('base64url') },
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
