# Backend API Contracts

This file documents the API contracts for the functions exposed by the backend layer of the Inbox Sales Copilot.

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

## Admin Auth Module

// ── Role 4 · Salma (Admin Auth) ───────────────────────────────────────────
// Email+password login for tenant admins (argon2id + JWT). JwtAuthGuard
// verifies the bearer token and sets req.user = { sub, tenantId, isAdmin,
// email }; tenant guards (Karim) compose after it. Every KB + external-content
// endpoint now derives tenantId from req.user, never from the body.
adminLoginWithPassword(email: string, password: string): Promise<{ token: string }>
// POST /auth/admin/login — generic 401 on any failure (no user enumeration)
setAdminPassword(email: string, password: string, tenantId: string): Promise<{ linked: true }>
// POST /auth/admin/set-password — writes the hash onto the SAME ConnectedAccount
// the Google flow created for that email; first-admin-per-tenant only.
linkAdminIdentities(tenantId: string, googleAccountId: string, passwordHash: string): Promise<void>
// Google + password converge on ONE account row — never a duplicate.

## Security Module

// ── Role 6 · Karim (Security) ─────────────────────────────────────────────
sanitizeForLog(text: string): string
// Imported by any module before logging anything that might contain user-provided text
// Masks emails, phone numbers, numeric national IDs, Luhn-valid cards, and IBANs.
// Also wired into Pino's logMethod hook, so every log line is masked automatically.

## CRM Module

// ── Role 3 · Nagy (CRM Per-Tenant Factory) ────────────────────────────────
getAdapterForTenant(tenantId: string): Promise<ICrmAdapter | null>
