-- Layer-1 deterministic document-quality output (additive, nullable).
-- quality_score: 0-100 weighted sales-coverage score.
-- quality_report: JSON { score, passed, failed, redundancyRatio, concisenessScore, ... }.
ALTER TABLE "documents" ADD COLUMN "quality_score" INTEGER;
ALTER TABLE "documents" ADD COLUMN "quality_report" JSONB;
