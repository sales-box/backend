-- Until now nothing in this database recorded whether a company had paid.
-- `tenants.tier` defaulted to 1 -- the $49/mo Starter plan -- so every tenant
-- became a paying-tier tenant the moment they clicked their email verification
-- link, and the guards happily let them in. Stripe was never consulted: the
-- webhook's only write was `tier`, which it could raise (1 -> 2) but never
-- lower, and `charge.refunded` was a bare console.log. There was no column that
-- could express "signed up, never paid", so there was no way to deny them.
--
-- This adds that column. `subscription_status` is billing state and is kept
-- deliberately separate from `tenants.status`, which is account lifecycle
-- (verified / suspended / offboarded). Email verification still sets
-- status='active'; only the signature-verified Stripe webhook may set
-- subscription_status='active'. There is no free tier, so every other value
-- denies access to the product.
--
-- NO BACKFILL, deliberately.
--
-- Every tenant currently in this database is test data, so all existing rows
-- take the column default and land on subscription_status='none' -- i.e. the
-- product locks for all of them until a real Stripe payment activates them.
-- That is the correct outcome here: none of them ever paid, and grandfathering
-- them would bake the very bug this migration exists to fix into the new
-- column.
--
-- This is the one assumption in this file that is not self-evident from the
-- schema. If this migration is ever applied to a database that DOES hold
-- paying customers, it will lock them out, and that database needs a backfill
-- reconciled against Stripe's successful PaymentIntents before this runs.
--
-- IF NOT EXISTS / IF EXISTS throughout so the migration is safe to re-apply.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status') THEN
    CREATE TYPE "subscription_status" AS ENUM ('none', 'active', 'past_due', 'canceled');
  END IF;
END
$$;

-- AlterTable
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "subscription_status" "subscription_status" NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "subscribed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "stripe_customer_id" TEXT;

-- Support reconciliation against Stripe without scanning the table.
CREATE INDEX IF NOT EXISTS "tenants_subscription_status_idx"
  ON "tenants"("subscription_status");

-- Webhook idempotency: one row per Stripe event id.
CREATE TABLE IF NOT EXISTS "processed_stripe_events" (
  "event_id"     TEXT NOT NULL PRIMARY KEY,
  "event_type"   TEXT NOT NULL,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
