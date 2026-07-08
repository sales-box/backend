# Backend API Contracts

This file documents the API contracts for the functions exposed by the backend layer of the Inbox Sales Copilot.

## Clients Module

// ── Role 1 · Nagy (Client Context) ──────────────────────────────────────
getClientContext(email: string): Promise<ClientContext>
// Returns: full context object | { isNewClient: true, history: [] } if unknown | never throws
