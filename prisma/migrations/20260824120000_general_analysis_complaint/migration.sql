-- AlterTable
--
-- Additive only: two new columns, both NOT NULL with a default, so every
-- existing row is valid the moment this lands and no backfill is needed.
-- Nothing is dropped, renamed or retyped.
--
-- The defaults are the honest reading of a row classified before complaint
-- detection existed: we did not look, so we did not find one.
ALTER TABLE "general_analysis"
  ADD COLUMN IF NOT EXISTS "is_complaint" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "complaint_about" TEXT NOT NULL DEFAULT 'none';

-- Supports the admin escalation feed: "complaints about a person, newest
-- first, for this tenant". Partial, because the overwhelming majority of rows
-- are not complaints and there is no reason to index them.
CREATE INDEX IF NOT EXISTS "idx_general_analysis_complaints"
  ON "general_analysis" ("tenant_id", "complaint_about", "created_at" DESC)
  WHERE "is_complaint" = true;
