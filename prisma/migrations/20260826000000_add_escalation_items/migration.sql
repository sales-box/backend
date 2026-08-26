-- Creates the escalation_items table declared in schema.prisma.
-- The model was added without a migration, so every deployed database was
-- missing the table; writes to it are wrapped in .catch(() => {}), which hid
-- the failure. Purely additive.

-- CreateTable
CREATE TABLE "escalation_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "general_analysis_id" UUID NOT NULL,
    "message_id" TEXT NOT NULL,
    "account_email" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escalation_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "escalation_items_general_analysis_id_key" ON "escalation_items"("general_analysis_id");

-- CreateIndex
CREATE INDEX "escalation_items_tenant_id_status_created_at_idx" ON "escalation_items"("tenant_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "escalation_items" ADD CONSTRAINT "escalation_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalation_items" ADD CONSTRAINT "escalation_items_general_analysis_id_fkey" FOREIGN KEY ("general_analysis_id") REFERENCES "general_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

