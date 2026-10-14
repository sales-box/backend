-- Additive only: one nullable column, no data rewritten, no constraint changed.
-- Existing rows keep resolved_at NULL, which reads as "never resolved" and
-- leaves their evidence list unfiltered — identical to today's behaviour.
ALTER TABLE "knowledge_gaps" ADD COLUMN "resolved_at" TIMESTAMP(3);
