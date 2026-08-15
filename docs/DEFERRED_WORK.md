# Deferred Work

This file records work intentionally excluded from the four-hour inbound client-memory patch and follow-up issues discovered while testing it end to end. The current patch is limited to exact-email client identity, idempotent inbound interaction capture, injecting the five most recent interactions into reply generation, and deterministic knowledge-gap reporting.

## Priority 1 — Data safety

### Block product recommendations when a referenced attachment is missing

End-to-end testing found that an email can mention an attached scope or
technical requirements even when Gmail reports no attachments. The current AI
pipeline may then retrieve a plausible product brochure and recommend that
product without having the requirements needed to establish fit.

Implement a deterministic guard before extraction and product matching:

- Detect a current-message attachment reference such as `attached`,
  `enclosed`, or `مرفق`.
- Treat Gmail's attachment list as the source of truth.
- When an attachment is referenced but the list is empty, skip extraction,
  product matching, and Knowledge Base retrieval.
- Produce a fixed reply asking the sender to resend the missing documents.
- Return no product recommendation and zero product-match confidence.
- Preserve the existing normal pipeline when an attachment is present or no
  attachment is referenced.

Required tests:

- Referenced attachment plus zero Gmail attachments produces the resend reply
  and contains no product name.
- Referenced attachment plus a real attachment follows the normal pipeline.
- No attachment reference and no attachment follows the normal pipeline.
- The missing-attachment path makes no matcher, retrieval, or reply-generation
  LLM call.

This follow-up requires no database migration or frontend change.

### Never infer or invent the seller's signature identity

End-to-end testing found that editing a draft can teach the feedback memory a
style preference such as "always use a specific name in the signature" without
recording the authenticated seller's actual name. The Composer may then satisfy
that preference by inventing a name, for example `Alex`.

Required behavior:

- Seller identity must come only from an authenticated account/profile field
  supplied by code.
- User-preference memory may control signature style, but must never create or
  override identity facts.
- When no verified seller name exists, use a neutral `Sales Team` signature or
  omit the signature name.
- Existing unsafe signature-memory entries must be ignored or cleaned safely.

Required tests:

- A preference requesting a specific signature cannot cause an invented name.
- A verified account display name is used when available.
- Missing display name falls back to `Sales Team`.
- Feedback from an edited draft cannot persist a new seller identity.

### Make background email identity explicitly tenant-scoped

The classifier job currently identifies a connected account by email address and status, while the database permits the same email address in different tenants. Carry a stable connected-account or tenant identifier in the job and resolve the account by that identifier.

Expected outcome:

- Background jobs cannot select another tenant's connected account.
- Existing queued jobs have a safe transition or compatibility path.
- Tests cover the same account email in two tenants.

### Scope cached analysis identity

`GeneralAnalysis` currently treats Gmail `messageId` as globally unique and some lookups use only that value. Confirm the provider-level uniqueness guarantee or migrate cache identity to include the owning account or tenant.

Expected outcome:

- Cached analysis cannot be reused across tenants or connected mailboxes.
- Background and on-demand paths share the same scoped identity.
- Migration and race tests cover existing analysis rows.

### Preserve history when disconnecting a CRM

Current CRM disconnect behavior can delete CRM-linked clients. Because interactions cascade when a client is deleted, disconnecting an integration may also remove interaction history.

Expected outcome:

- Disconnecting a CRM removes or disables the connection without deleting local clients or interactions.
- CRM identifiers may be cleared or archived while local history remains available.
- Tests cover disconnect, reconnect, and tenant isolation.

## Priority 2 — Outcome tracking

### Record what happened after a recommendation

Persist business outcomes after the user acts on a draft:

- `sent_as_is`
- `edited_and_sent`
- `skipped`
- `escalated`

The implementation should retain the original draft, final sent content, edit indicator or distance, and timestamps. It should update analytics and the activity feed from persisted outcomes rather than inferred UI state.

When this model is introduced, formalize interaction direction (for example, an enum) and decide how to backfill legacy rows whose `type` value is `email`. New inbound capture uses `inbound`; the four-hour patch does not rewrite historical data.

## Priority 3 — Company/account modeling

Introduce a separate Company or Account entity only when company-level workflows require it. Email domains may suggest company context, but must never identify or merge individual contacts.

The required future end-to-end coverage is defined in [Multi-Participant Company Context — End-to-End Test Plan](./MULTI_PARTICIPANT_COMPANY_E2E_TEST_PLAN.md).

Possible future requirements:

- Multiple contacts linked to one company
- Company-level CRM identifiers and deal data
- Company-level interaction summaries
- Domain aliases and verified domain ownership

## Priority 4 — Historical backfill

Optionally import older email conversations into client history. Backfill must be resumable, idempotent, tenant-scoped, rate-limited, and observable. It must not block normal inbound processing.

## Priority 5 — Product and tooling improvements

- Expand knowledge-gap categorization only from real report data. The current
  deterministic taxonomy intentionally selects one primary category per email;
  multi-gap extraction and taxonomy administration are deferred.
- Improve the activity-feed presentation after outcome data exists.
- Add optional external company enrichment with explicit data-source and privacy rules.
- Pin the supported pnpm version or move overrides to the workspace configuration so frozen installs behave consistently across developer and CI environments.
- Split the large dashboard production bundle when performance evidence justifies it.

## Not deferred

The current four-hour patch must still provide:

- Exact normalized-email identity within a tenant
- Separate contacts for different emails at the same domain
- Automatic creation of unknown inbound senders
- One inbound interaction per tenant and message ID
- Capture that survives AI pipeline failure and concurrent processing
- Five most recent interactions in reply-generation context
- Focused regression tests and full build verification
