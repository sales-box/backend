-- AlterTable: auto-logged interactions carry the Gmail message id for dedup
ALTER TABLE "interactions" ADD COLUMN "message_id" TEXT;

-- CreateIndex: one interaction per (tenant, message); NULLs (manual entries) stay distinct
CREATE UNIQUE INDEX "interactions_tenant_id_message_id_key" ON "interactions"("tenant_id", "message_id");
