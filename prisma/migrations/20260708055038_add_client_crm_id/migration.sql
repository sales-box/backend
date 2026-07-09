-- DropIndex
DROP INDEX "idx_chunks_vec";

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "crm_id" TEXT;
