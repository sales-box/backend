-- Hand-written. Prisma's generated version was DROP TABLE + CREATE TABLE, which
-- would have deleted every live Zoho connection on the shared database. This is
-- the same end state, reached by renaming, so no row is lost.

-- 1. Rename the table. It is no longer Zoho-specific: the agent stack is
--    provider-neutral and this row now says which CRM a tenant writes to.
ALTER TABLE "zoho_mcp_connections" RENAME TO "crm_agent_connections";

-- 2. Postgres keeps the old names on constraints and indexes after a table
--    rename. Rename them too, or the next migration Prisma generates will see a
--    mismatch and try to "fix" it.
ALTER TABLE "crm_agent_connections"
  RENAME CONSTRAINT "zoho_mcp_connections_pkey" TO "crm_agent_connections_pkey";

ALTER TABLE "crm_agent_connections"
  RENAME CONSTRAINT "zoho_mcp_connections_tenant_id_fkey" TO "crm_agent_connections_tenant_id_fkey";

ALTER INDEX "zoho_mcp_connections_tenant_id_key"
  RENAME TO "crm_agent_connections_tenant_id_key";

-- 3. Which CRM. Every existing row is a Zoho connection, so the default
--    backfills them correctly and the column can be NOT NULL from the start.
ALTER TABLE "crm_agent_connections"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'zoho';

-- 4. Only MCP-reached providers have a URL. HubSpot authenticates with the
--    private app token already held (encrypted) on crm_connections, so its rows
--    carry no URL.
ALTER TABLE "crm_agent_connections"
  ALTER COLUMN "mcp_server_url" DROP NOT NULL;
