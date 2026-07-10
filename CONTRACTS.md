# Backend API Contracts

This file documents the API contracts for the functions exposed by the backend layer of the Inbox Sales Copilot.

## Clients Module

// ── Role 1 · Nagy (Client Context) ──────────────────────────────────────
getClientContext(email: string): Promise<ClientContext>
// Returns: full context object | { isNewClient: true, history: [] } if unknown | never throws

## Security Module

// ── Role 6 · Karim (Security) ─────────────────────────────────────────────
sanitizeForLog(text: string): string
// Imported by any module before logging anything that might contain user-provided text
// Masks emails, phone numbers, numeric national IDs, Luhn-valid cards, and IBANs.
// Also wired into Pino's logMethod hook, so every log line is masked automatically.
