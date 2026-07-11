import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { extname } from 'node:path';
import { DocumentStatus } from '@prisma/client';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import { PDFParse } from 'pdf-parse';
import { PrismaService } from '../../database/prisma.service';
import type { PaginationOptions } from '../../database/pagination/pagination.types';
import { UploadResponseDto } from './dto/upload-response.dto';

const MAX_TOKENS_PER_CHUNK = 1000;
const CHUNK_OVERLAP_TOKENS = 150; // ~15% of chunk size

// Quality gate thresholds — a scanned/image PDF yields almost no text
// relative to its byte size; the admin must see that at upload time.
const MIN_EXTRACTED_TEXT_CHARS = 200;
const MIN_TEXT_TO_SIZE_RATIO = 0.001; // extracted chars per file byte

export interface DocumentQuality {
  isLowConfidence: boolean;
  qualityReason: string | null;
}

type FileType = 'pdf' | 'txt' | 'md';

const ALLOWED_TYPES: Record<string, FileType> = {
  '.pdf': 'pdf',
  '.txt': 'txt',
  '.md': 'md',
};

export interface IngestInput {
  filename: string;
  mimetype: string;
  buffer: Buffer;
}

interface Chunk {
  chunkIndex: number;
  content: string;
  tokenCount: number;
}

@Injectable()
export class KnowledgeBaseService {
  // cl100k_base matches OpenAI text-embedding-ada-002 / 3-small (our vector(1536)).
  private readonly encoding: Tiktoken = getEncoding('cl100k_base');

  constructor(private readonly prisma: PrismaService) {}

  async ingest({ filename, buffer }: IngestInput): Promise<UploadResponseDto> {
    const fileType = this.resolveFileType(filename);
    const text = await this.extractText(buffer, fileType);
    const chunks = await this.chunk(text);
    const quality = this.assessDocumentQuality(
      (text ?? '').trim().length,
      buffer.length,
      chunks.length,
    );
    return this.persist(filename, fileType, chunks, quality);
  }

  /**
   * Quality gate: flags uploads whose extraction looks unreliable so the
   * admin sees the warning immediately in the upload response — not months
   * later when the AI keeps guessing on a topic with no real content.
   */
  assessDocumentQuality(
    extractedTextLength: number,
    fileSizeBytes: number,
    chunkCount: number,
  ): DocumentQuality {
    if (chunkCount === 0) {
      return {
        isLowConfidence: true,
        qualityReason: 'No extractable text found',
      };
    }
    if (extractedTextLength < MIN_EXTRACTED_TEXT_CHARS) {
      return {
        isLowConfidence: true,
        qualityReason: `Very little extractable text (${extractedTextLength} characters)`,
      };
    }
    if (
      fileSizeBytes > 0 &&
      extractedTextLength / fileSizeBytes < MIN_TEXT_TO_SIZE_RATIO
    ) {
      return {
        isLowConfidence: true,
        qualityReason:
          'Extracted text is tiny relative to the file size — this may be a scanned or image-based document',
      };
    }
    return { isLowConfidence: false, qualityReason: null };
  }

  private resolveFileType(filename: string): FileType {
    const ext = extname(filename ?? '').toLowerCase();
    const fileType = ALLOWED_TYPES[ext];
    if (!fileType) {
      throw new BadRequestException(
        `Unsupported file type "${ext || 'unknown'}". Allowed: .pdf, .txt, .md`,
      );
    }
    return fileType;
  }

  private async extractText(
    buffer: Buffer,
    fileType: FileType,
  ): Promise<string> {
    if (fileType === 'pdf') {
      try {
        const parser = new PDFParse({ data: buffer });
        const { text } = await parser.getText();
        return text ?? '';
      } catch {
        // Corrupt or mislabelled PDFs are a client error, not a server crash.
        throw new BadRequestException('Invalid or corrupted PDF file');
      }
    }
    // txt / md are plain UTF-8.
    return buffer.toString('utf-8');
  }

  private countTokens = (text: string): number =>
    this.encoding.encode(text).length;

  private async chunk(text: string): Promise<Chunk[]> {
    const clean = (text ?? '').trim();
    if (!clean) {
      return [];
    }
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: MAX_TOKENS_PER_CHUNK,
      chunkOverlap: CHUNK_OVERLAP_TOKENS,
      lengthFunction: this.countTokens,
    });
    const parts = await splitter.splitText(clean);
    return parts.map((content, chunkIndex) => ({
      chunkIndex,
      content,
      tokenCount: this.countTokens(content),
    }));
  }

  private async persist(
    filename: string,
    fileType: FileType,
    chunks: Chunk[],
    quality: DocumentQuality,
  ): Promise<UploadResponseDto> {
    const status = chunks.length
      ? DocumentStatus.completed
      : DocumentStatus.failed;

    await this.prisma.$transaction(async (tx) => {
      // filename; ON DELETE CASCADE removes its old chunks, so no duplicates.
      await tx.document.deleteMany({ where: { filename } });

      const doc = await tx.document.create({
        data: {
          filename,
          fileType,
          status,
          chunkCount: chunks.length,
          processedAt: new Date(),
          processingError: chunks.length ? null : 'No extractable text found',
          isLowConfidence: quality.isLowConfidence,
          qualityReason: quality.qualityReason,
          // TODO(admin-auth): set tenantId + uploadedBy from the JWT claim.
        },
      });

      if (chunks.length) {
        // embedding stays NULL for now (populated later by the RAG worker).
        await tx.documentChunk.createMany({
          data: chunks.map((c) => ({
            documentId: doc.id,
            chunkIndex: c.chunkIndex,
            content: c.content,
            tokenCount: c.tokenCount,
          })),
        });
      }
    });

    return {
      filename,
      chunksCreated: chunks.length,
      status,
      isLowConfidence: quality.isLowConfidence,
      qualityReason: quality.qualityReason ?? undefined,
    };
  }

  /**
   * Paginated list of uploaded documents, newest first (dashboard).
   * TODO(DEP-1): add `tenantId` to the where clause once tenants land.
   */
  listDocuments(options?: PaginationOptions) {
    return this.prisma.extended.document.paginate(
      {
        select: {
          id: true,
          filename: true,
          fileType: true,
          status: true,
          chunkCount: true,
          uploadDate: true,
          processingError: true,
          isLowConfidence: true,
          qualityReason: true,
        },
        orderBy: { uploadDate: 'desc' },
      },
      options,
    );
  }

  /**
   * Deletes a document by id. Its chunks are removed by the ON DELETE CASCADE
   * FK on DocumentChunk, so no manual chunk cleanup is needed.
   * TODO(DEP-1): add `tenantId` to the where clause once tenants land.
   */
  async deleteDocument(id: string): Promise<void> {
    const { count } = await this.prisma.document.deleteMany({ where: { id } });
    if (count === 0) {
      throw new NotFoundException(`Document ${id} not found`);
    }
  }
}
