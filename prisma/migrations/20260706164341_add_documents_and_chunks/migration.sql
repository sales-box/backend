-- pgvector extension (idempotent; already enabled on shared DB)
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('processing', 'completed', 'failed');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "filename" VARCHAR NOT NULL,
    "product_name" VARCHAR,
    "file_type" VARCHAR,
    "status" "document_status" NOT NULL DEFAULT 'processing',
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "processing_error" TEXT,
    "uploaded_by" VARCHAR,
    "upload_date" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "chunk_index" INTEGER,
    "content" TEXT,
    "embedding" vector(1536),
    "token_count" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_documents_file" ON "documents"("filename", "product_name");

-- CreateIndex
CREATE INDEX "idx_chunks_doc" ON "document_chunks"("document_id");

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- pgvector similarity index (cosine, HNSW) for RAG search — US-014. Hand-added: Prisma can't emit index method on an Unsupported column.
CREATE INDEX "idx_chunks_vec" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);
