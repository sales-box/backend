-- CreateTable
CREATE TABLE "zoho_mcp_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "mcp_server_url" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "zoho_mcp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "zoho_mcp_connections_tenant_id_key" ON "zoho_mcp_connections"("tenant_id");

-- AddForeignKey
ALTER TABLE "zoho_mcp_connections" ADD CONSTRAINT "zoho_mcp_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
