-- Backfills the migration that PR #48 (feat: client identity, crm factory)
-- changed in schema.prisma but never generated: the crm_connections table and
-- the Interaction confidence split. The auto-generated `DROP INDEX idx_chunks_vec`
-- was removed on purpose — that pgvector index is maintained via raw SQL and must
-- survive (see 20260711003000_restore_chunks_vector_index).

-- AlterTable
ALTER TABLE "interactions" DROP COLUMN "confidence",
ADD COLUMN     "client_history_confidence" DOUBLE PRECISION,
ADD COLUMN     "product_confidence" DOUBLE PRECISION,
ADD COLUMN     "tenant_id" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "crm_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "crm_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crm_connections_tenant_id_key" ON "crm_connections"("tenant_id");
