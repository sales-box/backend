-- Resize document_chunks.embedding from vector(1536) to vector(768).
--
-- Why: the embedding provider is local Ollama `nomic-embed-text`, which
-- produces 768-dim vectors (the 1536 sizing assumed an OpenAI model we
-- don't have a key for). The column dimension must match the model exactly.
--
-- Why this is safe: every embedding is NULL right now (verified 2026-07-16:
-- SELECT count(*) FROM document_chunks WHERE embedding IS NOT NULL → 0),
-- so no data is converted or lost.
--
-- The HNSW index is dropped and recreated explicitly. See 20260711003000:
-- this index has been lost to migration drift before — keep it visible.
--
-- ⚠️ To every future migration author: if `prisma migrate dev` generates a
-- `DROP INDEX "idx_chunks_vec"` line, DELETE that line before applying.
DROP INDEX IF EXISTS "idx_chunks_vec";

ALTER TABLE "document_chunks" ALTER COLUMN "embedding" TYPE vector(768);

CREATE INDEX IF NOT EXISTS "idx_chunks_vec" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);
