# Backend API Contracts

This file documents the API contracts for the functions exposed by the backend layer of the Inbox Sales Copilot.

## Access Control Module

// ── Role 2 · Karim (Access Control) ───────────────────────────────────────
grantAccess(tenantId: string, email: string, tx?: Prisma.TransactionClient): Promise<void>
// Checks the tenant's plan-tier SE cap, records the entry as granted, emails
// the SE the extension install link. Optional tx so it can run inside another
// transaction (e.g. tenant activation grants the admin's own email).
verifyAccess(email: string): Promise<void> // called inside AuthService.handleGoogleCallback
// Throws ForbiddenException if the email is on no allowlist; else marks verified.
revokeAccess(tenantId: string, email: string): Promise<void>
// One transaction: allowlist entry -> revoked AND ConnectedAccount -> revoked.
offboardTenant(tenantId: string): Promise<void>
// Revokes every entry + account for the tenant and sets Tenant.status=offboarded.
// No client data is deleted; it just becomes unreachable.
listAllowlist(tenantId: string): Promise<AllowlistEntry[]> // email/status/dates for the dashboard
seLoginWithGoogle(code: string): Promise<{ token: string } | { error: 'invalid_allowlist' }>
// Confirms AllowlistEntry status verified/granted before returning a JWT.
//
// Endpoints: POST /tenants/:id/allowlist · DELETE /tenants/:id/allowlist/:email
// GET /tenants/:id/allowlist · POST /tenants/:id/offboard · POST /auth/se/login
// Guards: AdminTenantGuard (admin-of-tenant; on allowlist routes + /analytics/*,
// fulfils the "AnalyticsTenantGuard" requirement) · TenantAllowlistGuard
// (SE JWT + ConnectedAccount connected; for future extension endpoints).
// Reads req.user = { tenantId, isAdmin } — populated by admin login (TODO: Salma).

## Clients Module

// ── Role 3 · Nagy (Client Identity) ───────────────────────────────────────
resolveClientIdentity(tenantId: string, email: string, crmAdapter: ICrmAdapter): Promise<{ matchedBy: 'crm' | 'domain' | 'individual', existingClientId: string | null }>
getOrCreateClient(tenantId: string, email: string, name?: string, company?: string): Promise<ClientRecord>
getClientContext(tenantId: string, email: string): Promise<ClientContext>
// Interaction.confidence split into two:
// - productConfidence: number | null
// - clientHistoryConfidence: number | null

## External Content Module

// ── Role 3 · Salma (External Content) ─────────────────────────────────────
// BREAKING (tenant isolation): optional tenantId param added. The allow-list
// and the Drive connection are scoped to that tenant; a tenant can never use
// another tenant's Drive connection. Until Admin Auth lands, tenantId comes
// from the request body; afterwards it is derived from the admin JWT claim.
resolveExternalContent(emailBody: string, interactionId: string, tenantId?: string): Promise<ResolvedExternalContent[]>
// summary field is ALWAYS undefined this sprint — filled in later by the AI Phase
//
// type ResolvedExternalContent = {
// sourceType: 'google_drive' | 'unknown_link';
// originalRef: string; // the URL found in the email body
// domain: string;
// fetched: boolean;
// rawStorageKey?: string; // S3 key, only set when content was fetched and stored
// summary?: undefined; // reserved for the AI Phase
// skipped: boolean;
// reason?: 'unrecognized_domain' | 'fetch_failed' | 'parse_error' | 'not_attempted';
// detail?: string; // human-readable explanation when skipped
// }
//
// Guarantees: never throws — one bad link never blocks the others (per-link try/catch).
// Domains not on the AllowedDomain table are never fetched (SSRF boundary).

## Knowledge Base Module

// ── Role 4 · Salma (KB Quality Gate) ──────────────────────────────────────
assessDocumentQuality(extractedTextLength: number, fileSizeBytes: number, chunkCount: number): { isLowConfidence: boolean; qualityReason: string | null }
// Pure threshold check run at upload time. POST /knowledge-base/upload returns
// isLowConfidence/qualityReason immediately so the admin sees the warning at
// the door (e.g. scanned PDFs with almost no extractable text).

## Analytics Module

// ── Role 4 · Salma (baseline tenant isolation) ────────────────────────────
// BREAKING (tenant isolation): optional tenantId params added. With a tenant,
// numbers are filtered through the client relation so two companies never mix.
// The caller-is-admin-of-this-tenant guard is Karim's Analytics Guard.
getAnalyticsSummary(days?: number, tenantId?: string): Promise<AnalyticsSummary>
upsertKnowledgeGap(topic: string, tenantId?: string): Promise<KnowledgeGap>
// gaps are unique per (tenantId, topic) — same topic for two tenants = 2 rows
getKnowledgeGapAlerts(threshold?: number, tenantId?: string): Promise<KnowledgeGap[]>

## Security Module

// ── Role 6 · Karim (Security) ─────────────────────────────────────────────
sanitizeForLog(text: string): string
// Imported by any module before logging anything that might contain user-provided text
// Masks emails, phone numbers, numeric national IDs, Luhn-valid cards, and IBANs.
// Also wired into Pino's logMethod hook, so every log line is masked automatically.

## CRM Module

// ── Role 3 · Nagy (CRM Per-Tenant Factory) ────────────────────────────────
getAdapterForTenant(tenantId: string): Promise<ICrmAdapter | null>
