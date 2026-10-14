/*
  Warnings:

  - A unique constraint covering the columns `[tenant_id,email]` on the table `clients` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,email]` on the table `connected_accounts` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('pending', 'active', 'abandoned');

-- DropIndex
DROP INDEX "clients_email_key";

-- DropIndex
DROP INDEX "connected_accounts_email_key";

-- AlterTable
ALTER TABLE "allowed_domains" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "connected_accounts" ADD COLUMN     "is_admin" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "drive_connections" ADD COLUMN     "tenant_id" UUID;

-- CreateTable
CREATE TABLE "knowledge_gaps" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "tenant_id" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_name" TEXT NOT NULL,
    "status" "tenant_status" NOT NULL DEFAULT 'pending',
    "tier" INTEGER NOT NULL DEFAULT 1,
    "email_verified_at" TIMESTAMP(3),
    "email_verification_token" TEXT,
    "email_verification_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_gaps_topic_key" ON "knowledge_gaps"("topic");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_email_verification_token_key" ON "tenants"("email_verification_token");

-- CreateIndex
CREATE UNIQUE INDEX "clients_tenant_id_email_key" ON "clients"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "connected_accounts_tenant_id_email_key" ON "connected_accounts"("tenant_id", "email");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowed_domains" ADD CONSTRAINT "allowed_domains_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drive_connections" ADD CONSTRAINT "drive_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_gaps" ADD CONSTRAINT "knowledge_gaps_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
