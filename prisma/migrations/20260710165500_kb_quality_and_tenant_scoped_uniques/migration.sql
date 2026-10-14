-- Quality gate columns + per-tenant unique constraints.
-- Pre-conditions verified on the shared DB before this migration was written:
-- no duplicate (tenant_id, domain) or (tenant_id, topic) rows exist.

-- DropIndex: allow-list becomes per-tenant, not global
DROP INDEX "allowed_domains_domain_key";

-- DropIndex: knowledge-gap topics become per-tenant, not global
DROP INDEX "knowledge_gaps_topic_key";

-- AlterTable: document quality gate (flagged at upload time)
ALTER TABLE "documents" ADD COLUMN     "is_low_confidence" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "quality_reason" TEXT;

-- AlterTable: slot for the AI Phase ("Based on: X.pdf")
ALTER TABLE "interactions" ADD COLUMN     "source_snapshot" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "allowed_domains_tenant_id_domain_key" ON "allowed_domains"("tenant_id", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_gaps_tenant_id_topic_key" ON "knowledge_gaps"("tenant_id", "topic");
