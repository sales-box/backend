# Backend API Contracts

This file documents the API contracts for the functions exposed by the backend layer of the Inbox Sales Copilot.

## Clients Module

// ── Role 1 · Nagy (Client Context) ──────────────────────────────────────
getClientContext(email: string): Promise<ClientContext>
// Returns: full context object | { isNewClient: true, history: [] } if unknown | never throws

## External Content Module

// ── Role 3 · Salma (External Content) ─────────────────────────────────────
resolveExternalContent(emailBody: string, interactionId: string): Promise<ResolvedExternalContent[]>
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

## Security Module

// ── Role 6 · Karim (Security) ─────────────────────────────────────────────
sanitizeForLog(text: string): string
// Imported by any module before logging anything that might contain user-provided text
// Masks emails, phone numbers, numeric national IDs, Luhn-valid cards, and IBANs.
// Also wired into Pino's logMethod hook, so every log line is masked automatically.
