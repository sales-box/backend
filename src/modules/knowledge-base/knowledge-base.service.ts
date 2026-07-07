import { BadRequestException, Injectable } from '@nestjs/common';
import { extname } from 'node:path';
import { DocumentStatus } from '@prisma/client';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import { PDFParse } from 'pdf-parse';
import { PrismaService } from '../../database/prisma.service';
import { UploadResponseDto } from './dto/upload-response.dto';

const MAX_TOKENS_PER_CHUNK = 1000;
const CHUNK_OVERLAP_TOKENS = 150; // ~15% of chunk size

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
    return this.persist(filename, fileType, chunks);
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
      const parser = new PDFParse({ data: buffer });
      const { text } = await parser.getText();
      return text ?? '';
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

    return { filename, chunksCreated: chunks.length, status };
  }
}
