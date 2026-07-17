import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { AiModelService } from '../ai/ai.model.service';
import { EMBEDDINGS_QUEUE, EmbedDocumentJobData } from './embeddings.constants';

const BATCH_SIZE = 50;

/**
 * Background worker: embeds a freshly-uploaded document's chunks so they
 * become searchable by meaning (not just by keyword). Salma's upload stores
 * chunks with embedding = NULL; this fills them in seconds later.
 *
 * Idempotent by construction — it only ever selects this document's
 * NULL-embedding rows, so a BullMQ retry after a crash re-embeds nothing
 * already done. Same write path as scripts/backfill-embeddings.ts.
 */
@Processor(EMBEDDINGS_QUEUE)
export class EmbeddingsProcessor extends WorkerHost {
  private readonly logger = new Logger(EmbeddingsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiModelService: AiModelService,
  ) {
    super();
  }

  async process(job: Job<EmbedDocumentJobData>): Promise<{ embedded: number }> {
    const { documentId } = job.data;
    let embedded = 0;

    for (;;) {
      const batch = await this.prisma.$queryRaw<
        { id: string; content: string }[]
      >`
        SELECT id, content
        FROM document_chunks
        WHERE document_id = ${documentId}::uuid
          AND embedding IS NULL
          AND content IS NOT NULL
        LIMIT ${BATCH_SIZE}
      `;
      if (batch.length === 0) break;

      const vectors = await this.aiModelService.embedDocuments(
        batch.map((c) => c.content),
      );

      for (let i = 0; i < batch.length; i++) {
        // Raw SQL because Prisma types the column as Unsupported("vector").
        // pgvector accepts the '[0.1,0.2,...]' text form via a ::vector cast.
        await this.prisma.$executeRaw`
          UPDATE document_chunks
          SET embedding = ${JSON.stringify(vectors[i])}::vector
          WHERE id = ${batch[i].id}::uuid
        `;
      }
      embedded += batch.length;
    }

    this.logger.log(`document ${documentId}: embedded ${embedded} chunks`);
    return { embedded };
  }
}
