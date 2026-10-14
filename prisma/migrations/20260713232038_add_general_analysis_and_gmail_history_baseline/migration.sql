-- AlterTable
ALTER TABLE "webhook_subscriptions" ADD COLUMN     "last_history_id" TEXT;

-- CreateTable
CREATE TABLE "general_analysis" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" TEXT NOT NULL,
    "thread_id" TEXT,
    "account_email" TEXT NOT NULL,
    "tenant_id" UUID,
    "is_urgent" BOOLEAN NOT NULL,
    "urgency_reason" TEXT,
    "intent" TEXT NOT NULL,
    "intent_confidence" DOUBLE PRECISION NOT NULL,
    "reasoning" TEXT,
    "prompt_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "general_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "general_analysis_message_id_key" ON "general_analysis"("message_id");

-- CreateIndex
CREATE INDEX "general_analysis_tenant_id_is_urgent_idx" ON "general_analysis"("tenant_id", "is_urgent");

