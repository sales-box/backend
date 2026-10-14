# Multi-Participant Company Context — End-to-End Test Plan

## 1. Purpose

This plan validates the future workflow for email threads that contain:

- More than one contact from the client company
- Employees from the seller's company
- People from a third company, such as a partner, agency, or legal adviser
- Contacts using public email providers

The test must prove both data correctness and visible frontend behavior. Passing backend unit tests alone is not enough.

## 2. Business outcome being tested

Given this thread:

1. `ali@northstar.test` asks for 200 licenses, SSO, and an October 1 launch.
2. `mona@northstar.test` is copied and later replies that the budget is approved and requests final pricing and a DPA.
3. `omar@salesbox.test` is an internal Sales Engineer copied on the thread.

The finished product must:

- Keep Ali and Mona as separate contacts.
- Associate both contacts with Northstar without merging their personal records.
- Never create Omar as a client contact.
- Keep all messages in one conversation/account history.
- Identify the author and participants of each message.
- Give the AI the relevant shared facts from the thread.
- Avoid asking again for the license count, SSO requirement, or target date.
- Never expose internal notes in a customer-facing draft.
- Show the same correct account, contacts, conversation, and message state in the Gmail extension and dashboard.

## 3. Scope

### In scope

- Gmail `From`, `To`, and `CC` parsing
- Internal versus external participant classification
- Separate contact identity by normalized exact email
- Company/account association
- Conversation/thread association
- Message author and participant persistence
- Duplicate and concurrent processing
- Shared thread/account context in AI replies
- Gmail extension rendering and draft insertion
- Dashboard company, contact, timeline, and activity views
- Tenant isolation

### Out of scope

- Historical mailbox backfill
- Automatic merging of two email aliases into one person
- External company-enrichment providers
- Production analytics for sent/edited/skipped outcomes unless that feature has been implemented before this test runs

## 4. Preconditions before running the plan

The future implementation must expose enough data to verify:

- Company/account ID and name
- Contact ID, normalized email, and company association
- Conversation/thread ID
- Message/interaction ID and provider message ID
- Message author
- All `To` and `CC` participants
- Participant role: internal seller, external client, or external third party
- Interaction direction

The test environment must also provide:

- A staging backend and PostgreSQL database that may be reset safely
- A staging frontend and a production-mode extension build
- Google Workspace test mailboxes; never use employee or customer inboxes
- A deterministic stub AI mode for automated UI assertions
- A separate real-model staging run for reply-quality evaluation
- Stable test selectors in the dashboard and extension (`data-testid` or accessible roles/names)
- A way to inspect API responses and database rows after every scenario

## 5. Test identities

Use dedicated test accounts with no real customer data.

| Role                       | Address                | Expected classification       |
| -------------------------- | ---------------------- | ----------------------------- |
| Connected seller           | `sara@salesbox.test`   | Internal                      |
| Seller teammate            | `omar@salesbox.test`   | Internal                      |
| Client technical contact   | `ali@northstar.test`   | External, Northstar           |
| Client procurement contact | `mona@northstar.test`  | External, Northstar           |
| Client legal contact       | `legal@northstar.test` | External, Northstar           |
| Partner contact            | `partner@agency.test`  | External, Agency              |
| Independent consultant     | `consultant@gmail.com` | External, no inferred company |
| Tenant B seller            | `seller@tenant-b.test` | Internal to Tenant B only     |

Configure `salesbox.test` as Tenant A's verified internal domain. Do not classify a domain as internal merely because it appears in an email thread.

## 6. Reference email thread

### Message 1 — Initial inquiry

- From: `Ali Hassan <ali@northstar.test>`
- To: `sara@salesbox.test`
- CC: `mona@northstar.test`, `omar@salesbox.test`
- Subject: `Northstar SSO rollout`
- Body: `We need 200 licenses, SSO, and production launch by October 1.`

### Message 2 — Procurement reply

- From: `Mona Adel <mona@northstar.test>`
- To: `sara@salesbox.test`
- CC: `ali@northstar.test`, `omar@salesbox.test`
- Same Gmail thread
- Body: `The budget is approved. Please send final pricing and the DPA.`

### Message 3 — Internal teammate message

- From: `Omar Saleh <omar@salesbox.test>`
- To: `sara@salesbox.test`
- Same Gmail thread
- Body: `Internal note: do not promise a two-week implementation.`

The exact delivery order and Gmail message/thread IDs must be saved as test evidence.

## 7. P0 end-to-end scenarios

### E2E-01 — Initial multi-participant inbound message

Steps:

1. Send Message 1 to the connected staging mailbox.
2. Wait for webhook/background processing to complete.
3. Open the message in Gmail with the extension loaded.
4. Open the dashboard company and client views.

Backend assertions:

- One Northstar account exists.
- Ali and Mona exist as two separate contacts.
- Omar does not exist as a client contact.
- One conversation exists for the Gmail thread.
- One inbound message/interaction exists for Message 1.
- Ali is the author.
- Mona is an external participant.
- Omar is an internal participant.
- Reprocessing the same Gmail message creates no extra account, contact, conversation, or interaction.

Frontend assertions:

- The extension shows Ali as the current sender.
- The extension shows Northstar as the company/account.
- Mona is visible as another external participant.
- Omar is visually identified as internal and is never labelled as a client.
- The dashboard lists Ali and Mona under Northstar as separate contacts.
- The timeline shows one message, not one row per participant.

### E2E-02 — A copied client contact replies

Steps:

1. Send Message 2 as a reply in the same Gmail thread.
2. Wait for processing and open Message 2 in Gmail.
3. Generate the draft in the extension.

Backend assertions:

- No second Northstar account is created.
- Mona's existing contact is used.
- The same conversation/thread is used.
- Message 2 is authored by Mona.
- Ali remains a participant and a separate contact.
- Shared history contains Message 1 before drafting Message 2.

Draft-quality assertions:

- The draft acknowledges the request for final pricing and the DPA.
- When relevant, the draft uses the already-known 200-license, SSO, and October 1 facts.
- The draft does not ask for the license count, SSO requirement, or target date again.
- The draft does not claim that Mona originally supplied facts that Ali supplied.
- The draft does not invent price, availability, or delivery commitments.

Frontend assertions:

- The extension shows Mona as the current sender and Northstar as the account.
- The UI indicates that prior account/thread history exists.
- The generated draft appears in the briefing and can be inserted into Gmail.
- Inserting a draft does not modify the Gmail `To` or `CC` recipients.
- The dashboard timeline shows Message 1 followed by Message 2 in the correct order.

### E2E-03 — Internal teammate protection

Steps:

1. Send Message 3 from Omar in the same thread.
2. Process/open it using the same paths as a normal inbound message.
3. Open the dashboard and generate the next customer-facing draft.

Assertions:

- Omar is not created as a client or lead.
- Northstar's external-contact count does not increase.
- The internal note is labelled internal or excluded according to the approved product behavior.
- The internal message is not classified as a new client inquiry.
- The customer-facing draft never contains `Internal note` or the confidential two-week statement.
- Client-history confidence and activity counts are not inflated as though Omar were a customer.

### E2E-04 — Concurrent background and frontend processing

Steps:

1. Deliver a new external message.
2. Open it in Gmail immediately so `/ai/process` runs while the webhook worker is processing it.
3. Repeat the test several times with a clean database.

Assertions after each run:

- Exactly one contact exists for the sender.
- Exactly one conversation message/interaction exists for the Gmail message ID.
- The UI completes without a duplicate/error state.
- The final row contains classification and confidence enrichment when AI succeeds.
- The first message is not included in its own prior-history context.

### E2E-05 — Tenant isolation

Steps:

1. Create the same external email, company name, thread-like value, and message fixture under Tenant A and Tenant B.
2. Log in to each tenant's dashboard and extension separately.

Assertions:

- Each tenant sees only its own contacts, account, conversations, drafts, and activity.
- A provider message/cache result from Tenant A is never reused by Tenant B.
- Search and direct-ID API requests cannot retrieve the other tenant's data.
- Logs and traces contain the correct tenant/account identifier.

This scenario cannot be signed off until the deferred tenant-scoped mailbox selection and analysis-cache identity work is implemented.

## 8. P1 business edge cases

### E2E-06 — Two contacts at the same company

Process separate messages from Ali and Mona outside the shared thread.

Expected:

- Two contacts, one Northstar account.
- No personal history is reassigned between contacts.
- Account-level facts are shared only where product rules permit.

### E2E-07 — Third-party company in CC

Add `partner@agency.test` to the Northstar thread.

Expected:

- The partner is not added to Northstar as an employee.
- The partner remains associated with Agency or is shown as an external third party.
- Northstar and Agency are not merged because they share a thread.

### E2E-08 — Public-email participant

Add `consultant@gmail.com` to CC and let the consultant reply.

Expected:

- A separate consultant contact may be created.
- No company named `Gmail` is inferred.
- The consultant is not automatically attached to Northstar without explicit evidence or user action.

### E2E-09 — Participant added or removed mid-thread

Reply once without Mona in CC, then add Legal in the next reply.

Expected:

- Historical message participants remain unchanged.
- The conversation's current participant summary updates correctly.
- Legal becomes a separate Northstar contact only when product rules require contact creation.
- No duplicate timeline messages appear.

### E2E-10 — Case and display-name normalization

Send as `"ALI HASSAN" <Ali@NorthStar.Test>` after previously using `ali@northstar.test`.

Expected:

- The existing contact is reused.
- Display-name enrichment does not overwrite a stronger verified CRM name.
- No case-variant duplicate appears in the dashboard.

### E2E-11 — AI/provider failure

Force classifier and draft generation failures separately.

Expected:

- Contacts, participants, conversation, and inbound message remain persisted.
- The extension shows the approved error/manual-review state.
- Retrying enriches the same rows instead of creating duplicates.

## 9. Frontend automation strategy

The frontend currently has Vitest coverage for extension state/mapping but no browser E2E framework. Add browser automation only when the multi-participant UI contract is implemented.

### Layer A — Fast frontend contract tests

Use Vitest with API fixtures to verify:

- Account, sender, participant, and internal/external labels map correctly.
- Missing or legacy participant fields degrade safely.
- First-contact and returning-account states render correctly.
- Duplicate participant entries are removed by stable IDs, not display names.
- The frontend trusts the backend's role classification and does not infer internal status from appearance alone.

### Layer B — Dashboard browser tests

Use Playwright against staging to verify:

- Authentication and tenant switching
- Company/account list and detail page
- Separate contact records under one account
- Conversation timeline ordering
- Participant badges
- Search behavior
- Direct-link tenant authorization
- Activity feed shows one event per message with the correct author/account

Run these tests with deterministic seeded API/database fixtures.

### Layer C — Gmail extension browser tests

Use Playwright's Chromium persistent context with the production extension build loaded.

Verify:

- The sidebar opens for the selected Gmail message.
- The selected message ID/thread ID reaches the correct backend request.
- Sender, company, participants, and history state render correctly.
- Draft insertion changes only the compose body.
- `To` and `CC` recipients remain unchanged.
- Refresh/reopen does not duplicate processing.
- Switching between messages/threads does not show stale participant data.

Keep the authenticated Gmail test profile and OAuth secrets out of Git and CI artifacts. Record traces/screenshots only from synthetic test inboxes.

### Layer D — Real Gmail and real-model staging evaluation

Run the reference thread through real Gmail webhooks and the configured staging model. Do not assert exact wording. Score the draft using the business rubric in Section 10.

## 10. Reply-quality rubric

Score each generated draft pass/fail on every item:

1. Answers the latest sender's actual request.
2. Uses relevant known facts from the same conversation/account.
3. Does not repeat a question already answered.
4. Attributes people and facts correctly.
5. Does not expose internal-only text.
6. Does not mix facts from another tenant, company, or unrelated thread.
7. Does not invent price, commitments, availability, or legal terms.
8. Keeps the expected professional tone and is ready for human review.

Any failure in items 4–7 is a release blocker.

## 11. Evidence to capture

For every P0 scenario retain:

- Gmail message ID and thread ID
- Sender, recipient, and CC headers
- Relevant API request/response payloads with secrets removed
- Database IDs and row counts for account/contact/conversation/message records
- Extension screenshot
- Dashboard screenshot
- Browser trace on failure
- AI input-context summary and output with sensitive values removed
- Duplicate-count and tenant-isolation assertions

## 12. Entry and exit gates

### Entry gate

- Multi-participant backend/API contract is implemented and documented.
- Internal-domain configuration exists.
- Tenant-scoped mailbox selection and analysis-cache identity are fixed.
- Backend unit/integration tests pass.
- Frontend fixtures and stable selectors exist.
- Staging Gmail accounts and reset procedure are ready.

### Exit gate

- All P0 scenarios pass in automated staging runs.
- E2E-01 through E2E-03 pass once using real Gmail delivery.
- Tenant-isolation tests show zero cross-tenant reads or cache reuse.
- No internal employee is created as a client.
- No duplicate account/contact/message is created during retries or races.
- The reference reply passes every rubric item.
- Dashboard and extension show matching account/contact/thread state.
- Any remaining P1 failure has an owner, severity, and explicit release decision.

## 13. Suggested execution order

1. Backend database/API integration tests
2. Frontend Vitest contract tests
3. Dashboard Playwright tests
4. Gmail extension Playwright tests with stub AI
5. Real Gmail webhook smoke test
6. Real-model reply-quality evaluation
7. Tenant-isolation and security sign-off

Do not begin with manual Gmail testing before the deterministic backend and frontend layers pass; otherwise failures will be difficult to locate and reproduce.
