import { Test, TestingModule } from '@nestjs/testing';
import { AttachmentsService } from './attachments.service';
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

type MockGmailApi = {
  users: {
    messages: {
      attachments: {
        get: jest.Mock;
      };
    };
  };
};

describe('AttachmentsService', () => {
  let service: AttachmentsService;
  let mockGmailApi: MockGmailApi;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttachmentsService,
        { provide: GmailClientProvider, useValue: mockProvider },
      ],
    }).compile();

    service = module.get<AttachmentsService>(AttachmentsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('parsePdf', () => {
    it('1. should extract readable text from a PDF buffer', async () => {
      const buffer = Buffer.from('dummy pdf content');
      const text = await service.parsePdf(buffer);

      expect(text).toBe('mocked pdf text');
      expect(pdfParse.PDFParse).toHaveBeenCalledWith({ data: buffer });
    });
  });

  describe('parseImage', () => {
    it('2. should return a valid base64 string for an image buffer', () => {
      const buffer = Buffer.from('dummy image content');
      const base64 = service.parseImage(buffer);

      expect(base64).toBe(buffer.toString('base64'));
    });
  });

  describe('downloadAttachment', () => {
    it('5. should call Gmail API with correct messageId and attachmentId', async () => {
      // Mock Gmail returning base64url data
      mockGmailApi.users.messages.attachments.get.mockResolvedValue({
        data: { data: Buffer.from('test data').toString('base64url') },
      });

      const buffer = await service.downloadAttachment(
        'test@example.com',
        'msg-123',
        'att-456',
      );

      // Verify the API was called with the correct parameters
      expect(mockGmailApi.users.messages.attachments.get).toHaveBeenCalledWith({
        userId: 'me',
        messageId: 'msg-123',
        id: 'att-456',
      });

      // Verify base64url decoding worked correctly
      expect(buffer.toString('utf-8')).toBe('test data');
    });
  });

  describe('parseAttachment Gates', () => {
    it('3. should skip oversized attachments without calling Gmail API', async () => {
      const oversizedAtt = {
        filename: 'huge_presentation.pdf',
        mimeType: 'application/pdf',
        size: 15 * 1024 * 1024, // 15MB
        attachmentId: 'att-123',
      };

      const result = await service.parseAttachment(
        'test@example.com',
        'msg-1',
        oversizedAtt,
      );

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('exceeds_size_limit');

      // Ensure the download was never attempted
      expect(
        mockGmailApi.users.messages.attachments.get,
      ).not.toHaveBeenCalled();
    });
  });

  describe('parseAttachments Batch Processing', () => {
    it('4. should process 3 attachments (1 corrupt) and not fail the entire batch', async () => {
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
            filename: 'corrupt.pdf',
            mimeType: 'application/pdf',
            size: 1000,
            attachmentId: 'att-2',
          },
          {
            filename: 'photo.jpg',
            mimeType: 'image/jpeg',
            size: 1000,
            attachmentId: 'att-3',
          },
        ],
      };

      // Mock Gmail download behavior
      mockGmailApi.users.messages.attachments.get.mockImplementation(
        (args: { id: string }) => {
          if (args.id === 'att-2') {
            // Simulate a network failure or corrupted base64 for the second attachment
            return Promise.reject(new Error('Gmail API failed for att-2'));
          }
          return Promise.resolve({
            data: { data: Buffer.from('valid data').toString('base64url') },
          });
        },
      );

      const results = await service.parseAttachments('test@example.com', email);

      expect(results).toHaveLength(3);

      // Attachment 1: Valid PDF
      expect(results[0].filename).toBe('doc1.pdf');
      expect(results[0].skipped).toBeFalsy();
      expect(results[0].type).toBe('pdf');

      // We must cast to ParsedAttachment or any because TypeScript might not narrow it fully without type guards
      // but since we checked type === 'pdf', we can assert it has text.
      expect(results[0].text).toBe('mocked pdf text');

      // Attachment 2: Corrupted/Failed (but the batch didn't crash!)
      expect(results[1].filename).toBe('corrupt.pdf');
      expect(results[1].skipped).toBe(true);
      expect(results[1].reason).toBe('parse_error');

      // Attachment 3: Valid Image
      expect(results[2].filename).toBe('photo.jpg');
      expect(results[2].skipped).toBeFalsy();
      expect(results[2].type).toBe('image');
      expect(results[2].base64).toBeDefined();
    });
  });
});
