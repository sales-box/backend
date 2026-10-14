-- Make the documents uniqueness tenant-scoped: [filename, product_name]
-- -> [tenant_id, filename, product_name].
--
-- Why: the old constraint was NOT tenant-scoped, unlike clients and
-- connected_accounts (both unique on [tenant_id, ...]). The day product_name
-- is populated, two different tenants uploading the same filename+product
-- would collide — one tenant's upload blocking another's. Cross-tenant
-- interference in the schema.
--
-- Why it's safe now: product_name is currently 100% NULL, so no existing
-- rows conflict, and the new index is strictly MORE permissive (it allows
-- what the old one forbade). Nothing that inserts today stops working.
-- Same reasoning as the embedding-column resize: fix it while it's free.
DROP INDEX IF EXISTS "uq_documents_file";

CREATE UNIQUE INDEX "uq_documents_file"
  ON "documents" ("tenant_id", "filename", "product_name");
