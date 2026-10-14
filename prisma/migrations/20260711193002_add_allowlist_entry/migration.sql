-- AlterEnum
ALTER TYPE "tenant_status" ADD VALUE 'offboarded';

-- CreateTable
CREATE TABLE "allowlist_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'granted',
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "allowlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "allowlist_entries_tenant_id_email_key" ON "allowlist_entries"("tenant_id", "email");

-- AddForeignKey
ALTER TABLE "allowlist_entries" ADD CONSTRAINT "allowlist_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
