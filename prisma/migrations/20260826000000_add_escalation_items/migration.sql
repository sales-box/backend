-- The EscalationItem model has existed in schema.prisma since the supervisor
-- landed, but no migration ever created escalation_items -- the shared database
-- got the table out of band with `prisma db push`. Every database built from
-- prisma/migrations therefore had no such table, and both writers wrapped the
-- insert in `.catch(() => {})`, so every urgent, sensitive and complaint
-- escalation was discarded without a single log line. GET /analytics/escalations
-- answered 500.
--
-- Written defensively on purpose. Two kinds of database have to accept it:
--
--   * a FRESH one (CI, a new developer machine) where nothing exists yet, and
--   * the SHARED one, which already carries this exact table from the db push.
--
-- A plain CREATE TABLE would abort on the shared instance with "relation
-- already exists", and a failed migration blocks every later migration for the
-- whole team until somebody runs `migrate resolve` by hand. Every statement
-- below is therefore a no-op when the object is already there.
--
-- Purely additive either way: one table, one unique constraint, one index and
-- two foreign keys. Nothing existing is dropped, altered or rewritten, so there
-- is no path here that can lose data.

-- CreateTable
CREATE TABLE IF NOT EXISTS "escalation_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "general_analysis_id" UUID NOT NULL,
    "message_id" TEXT NOT NULL,
    "account_email" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escalation_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "escalation_items_general_analysis_id_key" ON "escalation_items"("general_analysis_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "escalation_items_tenant_id_status_created_at_idx" ON "escalation_items"("tenant_id", "status", "created_at");

-- AddForeignKey
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so guard on pg_constraint.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'escalation_items_tenant_id_fkey'
    ) THEN
        ALTER TABLE "escalation_items"
            ADD CONSTRAINT "escalation_items_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'escalation_items_general_analysis_id_fkey'
    ) THEN
        ALTER TABLE "escalation_items"
            ADD CONSTRAINT "escalation_items_general_analysis_id_fkey"
            FOREIGN KEY ("general_analysis_id") REFERENCES "general_analysis"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;
