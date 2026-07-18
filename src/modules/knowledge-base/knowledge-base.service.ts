import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { extname } from 'node:path';
import { DocumentStatus } from '@prisma/client';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';
import * as ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { PrismaService } from '../../database/prisma.service';
import type { PaginationOptions } from '../../database/pagination/pagination.types';
import { UploadResponseDto } from './dto/upload-response.dto';
import {
  EMBEDDINGS_QUEUE,
  EMBED_DOCUMENT_JOB,
} from '../embeddings/embeddings.constants';

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

type FileType = 'pdf' | 'txt' | 'md' | 'docx' | 'xlsx' | 'pptx';

const ALLOWED_TYPES: Record<string, FileType> = {
  '.pdf': 'pdf',
  '.txt': 'txt',
  '.md': 'md',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
  '.ppt': 'pptx',
};

export interface IngestInput {
  filename: string;
  mimetype: string;
  buffer: Buffer;
}

/** Tenant identity of the uploader, derived from the admin JWT claim. */
export interface UploadOwner {
  tenantId: string | null;
  uploadedBy: string;
}

interface Chunk {
  chunkIndex: number;
  content: string;
  tokenCount: number;
}

@Injectable()
export class KnowledgeBaseService {
  private readonly logger = new Logger(KnowledgeBaseService.name);
  // cl100k_base is used for token *counting* during chunking. The embedding
  // model is nomic-embed-text (vector(768), via Ollama) — a different
  // tokenizer, but chunk-size budgeting only needs a consistent approximation.
  private readonly encoding: Tiktoken = getEncoding('cl100k_base');

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(EMBEDDINGS_QUEUE) private readonly embeddingsQueue: Queue,
  ) {}

  async ingest(
    { filename, buffer }: IngestInput,
    owner?: UploadOwner,
  ): Promise<UploadResponseDto> {
    const fileType = this.resolveFileType(filename);
    const text = await this.extractText(buffer, fileType);
    const chunks = await this.chunk(text);
    const quality = this.assessDocumentQuality(
      (text ?? '').trim().length,
      buffer.length,
      chunks.length,
    );
    return this.persist(filename, fileType, chunks, quality, owner);
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
        `Unsupported file type "${ext || 'unknown'}". Allowed: .pdf, .txt, .md, .docx, .xlsx, .pptx`,
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
        throw new BadRequestException('Invalid or corrupted PDF file');
      }
    }

    if (fileType === 'docx') {
      try {
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
      } catch {
        throw new BadRequestException('Invalid or corrupted DOCX file');
      }
    }

    if (fileType === 'xlsx') {
      try {
        const workbook = new ExcelJS.Workbook();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        await workbook.xlsx.load(buffer as any);
        const lines: string[] = [];
        workbook.eachSheet((worksheet) => {
          lines.push(`## ${worksheet.name}`);
          worksheet.eachRow((row) => {
            const values = Array.isArray(row.values) ? row.values.slice(1) : [];
            lines.push(values.map(String).join('\t'));
          });
        });
        return lines.join('\n');
      } catch {
        throw new BadRequestException('Invalid or corrupted XLSX file');
      }
    }

    if (fileType === 'pptx') {
      try {
        const zip = await JSZip.loadAsync(buffer);
        const slideKeys = Object.keys(zip.files)
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort();
        const slideTexts: string[] = [];
        for (const slideKey of slideKeys) {
          const xmlContent = await zip.files[slideKey].async('string');
          const textMatches: string[] =
            xmlContent.match(/<a:t[^>]*>[^<]+<\/a:t>/g) ?? [];
          const slideText = textMatches
            .map((tag: string) => tag.replace(/<[^>]+>/g, '').trim())
            .filter(Boolean)
            .join(' ');
          const slideNumber = slideKey.match(/slide(\d+)/)?.[1] ?? '?';
          slideTexts.push(`## Slide ${slideNumber}\n${slideText}`);
        }
        return slideTexts.join('\n\n');
      } catch {
        throw new BadRequestException('Invalid or corrupted PPTX file');
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
    owner?: UploadOwner,
  ): Promise<UploadResponseDto> {
    const status = chunks.length
      ? DocumentStatus.completed
      : DocumentStatus.failed;

    let documentId: string | null = null;

    await this.prisma.$transaction(async (tx) => {
      // Replace the tenant's own document with the same filename; ON DELETE
      // CASCADE removes its old chunks, so no duplicates. Never touches
      // another tenant's file of the same name.
      await tx.document.deleteMany({
        where: { filename, tenantId: owner?.tenantId ?? null },
      });

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
          tenantId: owner?.tenantId ?? null,
          uploadedBy: owner?.uploadedBy ?? null,
        },
      });
      documentId = doc.id;

      if (chunks.length) {
        // Chunks are stored with embedding = NULL; the embeddings worker
        // (enqueued below, after commit) fills them in.
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

    // Enqueue AFTER the transaction commits (never inside it — the worker
    // could start before the rows are visible). Fire-and-forget: a failed
    // enqueue must not fail the upload; the chunks are safely stored and a
    // manual/scheduled backfill still covers them.
    if (documentId && chunks.length) {
      await this.embeddingsQueue
        .add(
          EMBED_DOCUMENT_JOB,
          { documentId },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        )
        .catch((err) =>
          this.logger.error(
            `failed to enqueue embedding job for document ${documentId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
    }

    return {
      filename,
      chunksCreated: chunks.length,
      status,
      isLowConfidence: quality.isLowConfidence,
      qualityReason: quality.qualityReason ?? undefined,
    };
  }

  /**
   * Paginated list of the tenant's OWN documents, newest first (dashboard).
   * Admins without a tenant (legacy tokens) only see pre-tenant NULL rows.
   */
  listDocuments(options?: PaginationOptions, tenantId?: string | null) {
    return this.prisma.extended.document.paginate(
      {
        where: { tenantId: tenantId ?? null },
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
   * Deletes the tenant's OWN document by id — another tenant's document with
   * the same id is a 404, never a cross-tenant delete. Chunks are removed by
   * the ON DELETE CASCADE FK on DocumentChunk.
   */
  async deleteDocument(id: string, tenantId?: string | null): Promise<void> {
    const { count } = await this.prisma.document.deleteMany({
      where: { id, tenantId: tenantId ?? null },
    });
    if (count === 0) {
      throw new NotFoundException(`Document ${id} not found`);
    }
  }
}
