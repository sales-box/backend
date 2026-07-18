-- DropIndex
DROP INDEX "idx_chunks_vec";

-- AlterTable
ALTER TABLE "general_analysis" ADD COLUMN     "client_history_confidence" DOUBLE PRECISION,
ADD COLUMN     "product_confidence" DOUBLE PRECISION,
ADD COLUMN     "reviewed_at" TIMESTAMPTZ(6),
ADD COLUMN     "supervisor_label" TEXT;
