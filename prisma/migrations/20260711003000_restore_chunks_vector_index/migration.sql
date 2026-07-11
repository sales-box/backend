-- Restore the pgvector HNSW similarity index on document_chunks.embedding.
-- It was created in 20260706164341 and silently dropped by the auto-generated
-- 20260708055038 migration: `prisma migrate dev` treats hand-written indexes
-- on Unsupported("vector") columns as drift because they cannot be expressed
-- in schema.prisma.
--
-- ⚠️ To every future migration author: if `prisma migrate dev` generates a
-- `DROP INDEX "idx_chunks_vec"` line, DELETE that line before applying.
CREATE INDEX IF NOT EXISTS "idx_chunks_vec" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);
