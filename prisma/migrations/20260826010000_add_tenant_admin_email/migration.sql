-- Signup mailed a verification link to dto.adminEmail and then threw the
-- address away: nothing on the tenant recorded who started the signup. So
-- `resendVerification` could not resolve a tenant from an email. It fell back
-- to "the most recently created pending tenant", rotated THAT tenant's token,
-- and mailed it to whoever asked -- meaning the person who asked for their own
-- link received a link that verifies somebody else's company, while their own
-- verification stayed stuck.
--
-- The same missing binding is what let `verify` accept any token for any email
-- and let `set-password` claim an adminless tenant.
--
-- Purely additive: one nullable column and one index. Existing rows keep a
-- NULL admin_email and are handled explicitly in code, so no existing tenant
-- is affected and nothing is rewritten.
--
-- IF NOT EXISTS on both statements so the migration is safe to re-apply and
-- safe on an environment that already picked the column up some other way.

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "admin_email" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tenants_status_admin_email_idx" ON "tenants"("status", "admin_email");
