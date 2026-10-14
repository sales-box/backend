-- Admin email+password login: argon2id hash on the SAME row as the Google
-- connection, so both identities converge on one ConnectedAccount.
ALTER TABLE "connected_accounts" ADD COLUMN "password_hash" TEXT;
