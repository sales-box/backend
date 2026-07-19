-- AlterTable
ALTER TABLE "connected_accounts" ADD COLUMN     "last_login_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "general_analysis_tenant_id_account_email_idx" ON "general_analysis"("tenant_id", "account_email");
