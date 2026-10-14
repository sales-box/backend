CREATE TABLE "knowledge_gap_reports" (
    "id" TEXT NOT NULL,
    "knowledge_gap_id" TEXT NOT NULL,
    "interaction_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_gap_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_gap_reports_interaction_id_key"
ON "knowledge_gap_reports"("interaction_id");

CREATE INDEX "knowledge_gap_reports_knowledge_gap_id_created_at_idx"
ON "knowledge_gap_reports"("knowledge_gap_id", "created_at");

ALTER TABLE "knowledge_gap_reports"
ADD CONSTRAINT "knowledge_gap_reports_knowledge_gap_id_fkey"
FOREIGN KEY ("knowledge_gap_id") REFERENCES "knowledge_gaps"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_gap_reports"
ADD CONSTRAINT "knowledge_gap_reports_interaction_id_fkey"
FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
