# Inbox Sales Copilot — Backend

Multi-tenant B2B sales assistant. It classifies inbound client emails in the
background and drafts AI-assisted replies grounded in each tenant's own
knowledge base — with a human always in the loop (no email is ever auto-sent).
NestJS (Fastify) modular monolith on PostgreSQL + pgvector and Redis/BullMQ.

## Stack

- **Runtime:** Node.js ≥ 22.13 (`.nvmrc`), pnpm 11.9
- **Framework:** NestJS 11 on Fastify 5
- **ORM:** Prisma 6 (PostgreSQL + pgvector)
- **Cache:** `@nestjs/cache-manager` + Keyv (Redis)
- **Queues:** BullMQ + Bull Board dashboard (`/admin/queues`)
- **AI:** provider-agnostic OpenAI SDK (`openai`) against a configurable
  `baseURL` (currently Groq/Llama) + LangChain & **LangGraph** for the reply
  pipeline
- **Logging:** nestjs-pino (JSON in prod, pretty in dev), PII-masked
- **Security:** helmet, CORS, signed cookies, CSRF (per-route), argon2id
  passwords, encrypted OAuth tokens, strict global validation, Redis rate limiting
- **Payments:** Stripe
- **API tooling:** Swagger (OpenAPI) at `/docs` + Orval client codegen
- **Observability:** Prometheus metrics at `/metrics`

## Prerequisites

- Node 22 (`nvm install 22 && nvm use 22`)
- pnpm (`corepack enable`)
- Docker + Docker Compose (local Postgres + Redis)
- An OpenAI-compatible LLM key (Groq free tier works) — for the AI pipeline
- A filled `.env` (`cp .env.example .env`)

## Quick start

```bash
nvm use 22
pnpm install
cp .env.example .env                 # fill the secrets (see table below)

docker compose up -d postgres redis  # local infra

pnpm exec prisma generate            # generate the Prisma client
pnpm exec prisma migrate deploy      # apply migrations (see DB policy!)

pnpm start:dev                       # watch mode, http://localhost:3000
```

Then: Swagger at `/docs`, Bull Board at `/admin/queues`, metrics at `/metrics`,
health at `/health`.

> ⚠️ Do **not** use `prisma db push` — the database is shared and migrations are
> additive-only. See [Database](#database).

## Environment variables

Validated at boot by [`src/config/env.validation.ts`](src/config/env.validation.ts) —
the app refuses to start if a required var is missing or malformed. Vars with a
default may be omitted locally.

### Core

| Var                      | Purpose                                                      | Default                 |
| ------------------------ | ------------------------------------------------------------ | ----------------------- |
| `NODE_ENV`               | `development` \| `production` \| `test`                      | `development`           |
| `PORT`                   | HTTP port (binds `0.0.0.0`)                                  | `3000`                  |
| `API_URL`                | Public base URL of this API                                  | `http://localhost:3000` |
| `FRONTEND_DASHBOARD_URL` | Dashboard SPA origin (verify/OAuth redirects derive from it) | — (required)            |
| `EXTENSION_INSTALL_URL`  | Chrome-extension install link (SE invite email)              | — (required)            |
| `CORS_ORIGINS`           | Comma-separated allowed origins                              | `http://localhost:5173` |

### Database & cache

| Var                         | Purpose                                       | Default              |
| --------------------------- | --------------------------------------------- | -------------------- |
| `DATABASE_URL`              | Postgres connection string (pgvector-enabled) | — (required)         |
| `REDIS_HOST` / `REDIS_PORT` | Redis for cache, queues, rate limiting        | `localhost` / `6379` |

### Auth & security

| Var                               | Purpose                                           | Default         |
| --------------------------------- | ------------------------------------------------- | --------------- |
| `JWT_SECRET`                      | Signs admin + SE JWTs (min 32 chars)              | dev default     |
| `JWT_EXPIRES_IN`                  | Admin token TTL                                   | `1h`            |
| `COOKIE_SECRET`                   | Signs cookies (min 16 chars)                      | — (required)    |
| `TOKEN_ENCRYPTION_KEY`            | Encrypts stored OAuth tokens (32-byte base64/hex) | — (required)    |
| `THROTTLE_TTL` / `THROTTLE_LIMIT` | Global rate-limit window / cap                    | `60000` / `100` |

### Google (OAuth + Gmail Pub/Sub)

| Var                                                                 | Purpose                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | OAuth app credentials (required)                                    |
| `GOOGLE_SCOPES`                                                     | Gmail OAuth scopes (required)                                       |
| `GOOGLE_DRIVE_SCOPES`                                               | Drive scopes (external content) — default `.../auth/drive.readonly` |
| `GOOGLE_PUBSUB_TOPIC_NAME`                                          | Pub/Sub topic for the Gmail `watch` (required)                      |
| `GOOGLE_PUBSUB_VERIFICATION_TOKEN`                                  | Shared token the webhook checks (`?token=`) (required)              |

### LLM (AI pipeline)

Provider-agnostic (OpenAI SDK + configurable `baseURL`) — switching provider is
a `.env` change, no code change.

| Var                                       | Purpose                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `LLM_API_KEY`                             | API key for the OpenAI-compatible provider (required)                      |
| `LLM_BASE_URL`                            | Provider base URL (e.g. Groq) (required)                                   |
| `LLM_MODEL`                               | Text model for structured output (classify / extract / compose) (required) |
| `VISION_MODEL`                            | Multimodal model for attachment/image analysis (required)                  |
| `LANGSMITH_TRACING` / `LANGSMITH_API_KEY` | Optional LangSmith tracing for the LangGraph pipeline                      |

### Integrations

| Var                                                                      | Purpose                                                                                                                                               |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SMTP_HOST` / `SMTP_PORT`                                                | Outbound email host/port — default `smtp.gmail.com` / `587`                                                                                           |
| `SMTP_USER` / `SMTP_PASS`                                                | SMTP credentials (required). Emails are sent **as `SMTP_USER`** (Gmail rejects a mismatched From).                                                    |
| `CRM_PROVIDER`                                                           | `Mock` \| `HubSpot` — default `Mock` (`HUBSPOT_API_KEY` required when `HubSpot`)                                                                      |
| `AWS_REGION` / `S3_BUCKET`                                               | Object storage for fetched external content (required)                                                                                                |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`                            | S3 credentials (read by the AWS SDK; listed in `.env.example`, not checked by the validator)                                                          |
| `S3_ENDPOINT`                                                            | Optional S3 endpoint override (e.g. LocalStack)                                                                                                       |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe billing. Not in the boot validator, **but the Stripe service crashes at startup without `STRIPE_SECRET_KEY`** — set it (a dummy works locally) |

## Scripts

| Command                                         | Purpose                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm start:dev`                                | Run with watch (`nest start --watch`)                               |
| `pnpm start:prod`                               | Run a built app (`node dist/main`)                                  |
| `pnpm build`                                    | Compile to `dist/` (`nest build && tsc-alias`)                      |
| `pnpm lint`                                     | ESLint with `--fix` over `{src,apps,libs,test}`                     |
| `pnpm format`                                   | Prettier                                                            |
| `pnpm test` / `pnpm test:e2e` / `pnpm test:cov` | Unit / e2e / coverage                                               |
| `pnpm exec prisma migrate deploy`               | Apply migrations (see DB policy)                                    |
| `pnpm openapi:gen`                              | Emit `openapi.json` (needs Postgres + Redis up)                     |
| `pnpm api:gen`                                  | Generate the typed API client (Orval)                               |
| `pnpm studio`                                   | LangGraph Studio dev server for the reply graph (`langgraphjs dev`) |

## Modules

Registered in [`src/app.module.ts`](src/app.module.ts):

| Module                                                                                        | Responsibility                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prometheus / Config / Schedule / EventEmitter / GracefulShutdown / Logger / Cache / Throttler | Platform: metrics, env validation, cron, in-process events, clean shutdown, PII-masked logs, Redis cache, Redis rate limiting                                                                                                                   |
| PrismaModule                                                                                  | Prisma client (global)                                                                                                                                                                                                                          |
| QueueModule                                                                                   | BullMQ root connection + Bull Board (`/admin/queues`)                                                                                                                                                                                           |
| HealthModule                                                                                  | `GET /health`                                                                                                                                                                                                                                   |
| EmailModule                                                                                   | Gmail OAuth client, parser, and the Pub/Sub **webhook → classifier queue**                                                                                                                                                                      |
| AuthModule                                                                                    | Google OAuth (admin connect + SE login), admin email+password login (argon2id + JWT), guards. Mounts **AllowlistModule** (SE seat management under `/tenants/:tenantId/allowlist*`) which in turn uses **EmailNotifyModule** (SE invite emails) |
| EmailsModule                                                                                  | Inbox stats + thread history (Gmail read paths)                                                                                                                                                                                                 |
| ClientsModule                                                                                 | Client identity resolution + interaction history                                                                                                                                                                                                |
| CrmModule                                                                                     | Per-tenant CRM adapter factory (mock / HubSpot) + sync queue                                                                                                                                                                                    |
| AttachmentsModule                                                                             | Download + parse email attachments (PDF/Docx/Xlsx/Pptx/image)                                                                                                                                                                                   |
| KnowledgeBaseModule                                                                           | Tenant KB upload, pgvector chunks, upload-time quality gate                                                                                                                                                                                     |
| ExternalContentModule                                                                         | Resolve Google-Drive / links found in emails (SSRF-bounded)                                                                                                                                                                                     |
| AnalyticsModule                                                                               | Per-tenant activity, analytics summary, knowledge gaps                                                                                                                                                                                          |
| **AiModule**                                                                                  | The AI pipeline — **Classifier** (background) + **reply graph** (Extractor → Composer). `POST /ai/process` is still a stub                                                                                                                      |
| LlmModule                                                                                     | Provider-agnostic `LlmClientService` (`generateStructured`, `analyzeImage`) + prompt-injection prefilter (global)                                                                                                                               |
| TenantsModule                                                                                 | Tenant signup / email verification / status / update                                                                                                                                                                                            |
| PaymentModule                                                                                 | Stripe payment intents (`/payments/*`) + Stripe webhook (`/stripe/webhook`)                                                                                                                                                                     |

## HTTP API

Full spec at `/docs` (Swagger). Highlights:

| Area                      | Routes                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health / docs / metrics   | `GET /health` · `GET /docs` · `GET /docs-json` · `GET /metrics` · `GET /admin/queues` · `POST /queue/demo/enqueue` (queue demo)                                                 |
| Auth                      | `GET /auth/google` · `GET /auth/google/callback` · `POST /auth/se/login` · `GET /auth/me` · `GET /auth/se/session` · `POST /auth/admin/login` · `POST /auth/admin/set-password` |
| Tenants                   | `POST /tenants/signup` · `GET /tenants/verify` · `GET /tenants/:id` · `PATCH /tenants/:tenantId`                                                                                |
| Allowlist (SE seats)      | `POST /tenants/:tenantId/allowlist` · `GET /tenants/:tenantId/allowlist` · `DELETE /tenants/:tenantId/allowlist/:email` · `POST /tenants/:tenantId/offboard`                    |
| Emails (SE)               | `GET /emails/inbox-stats` · `GET /emails/thread-history?email=…`                                                                                                                |
| Knowledge base            | `POST /knowledge-base/upload` · `GET /knowledge-base/documents` · `DELETE /knowledge-base/documents/:id`                                                                        |
| External content          | `POST /external-content/resolve`                                                                                                                                                |
| Clients / Analytics / CRM | `/clients/*` · `/analytics/*` · `/tenants/:id/crm/*` (admin, tenant-scoped)                                                                                                     |
| Payments                  | `POST /payments/create-payment-intent` · `GET /payments/:id` (admin) · `POST /stripe/webhook`                                                                                   |
| Webhooks                  | `POST /gmail/webhook?token=…` (Gmail Pub/Sub → classifier)                                                                                                                      |
| AI                        | `POST /ai/process` — **placeholder, returns 501**                                                                                                                               |

**Guards:** `JwtAuthGuard` (bearer JWT → `req.user = { sub, tenantId, isAdmin, email }`)
· `AdminTenantGuard` (admin-of-this-tenant) · `TenantAllowlistGuard` (SE JWT +
still-connected account, revocation-aware) · `GmailWebhookGuard` (Pub/Sub token)
· global `ThrottlerGuard` (100/60s; tighter overrides on login/upload/`ai/process`).
The Stripe webhook is unguarded and verified by the `stripe-signature` header.

## AI pipeline

Hybrid design (background classify once per email; reply drafted on demand):

- **Classifier — LIVE (background, once per email).** A Gmail Pub/Sub
  notification hits `POST /gmail/webhook`, which enqueues a job on the
  `classifier` BullMQ queue (jobId `email#historyId` dedups redeliveries). The
  worker diffs Gmail history for new INBOX messages, cleans each body, and calls
  the LLM (temperature 0, structured output) for
  `{ isUrgent, urgencyReason, intent, intentConfidence }`
  (intent ∈ `product inquiry | demo request | support | follow-up | sensitive`).
  Stored **once** in `general_analysis` (unique per `messageId`) — the "General
  Analysis" cache downstream stages read.
- **Reply graph — LIVE (LangGraph).** `ReplyService` runs a two-node
  `@langchain/langgraph` graph: **Extractor** (pulls features / constraints /
  scale / budget / timeline, infer-but-flag) → **Composer** (drafts the reply +
  labels each claim verified/flagged/hallucinated). The Composer's product-match
  inputs are still mocked pending the Matcher stage.
- **`POST /ai/process` — STUB.** Currently returns `501 Not Implemented`; it will
  expose the reply pipeline once wired.
- **Security (LIVE, applied to every external text before the LLM):** a
  prompt-injection **prefilter** (`flagSuspiciousContent`, logs/flags) + an
  **untrusted-content wrapper** (`wrapUntrustedContent` cages the text as
  `<untrusted_content source="…">`), plus closed output schemas.

LLM access goes through two thin layers over the same OpenAI-compatible endpoint:
`LlmClientService` (raw OpenAI SDK — classifier + vision) and `AiModelService`
(LangChain `ChatOpenAI` — the reply graph). Contracts for each stage live in
[`CONTRACTS.md`](CONTRACTS.md).

## Database

PostgreSQL + **pgvector**, Prisma ORM (generates the client and an `ERD.md`). The
deployed database is a **shared remote instance** — treat migrations with care.

Models (14): `Tenant`, `AllowlistEntry`, `ConnectedAccount`, `Client`,
`Interaction`, `CrmConnection`, `ProcessedGmailMessage`, `WebhookSubscription`,
`GeneralAnalysis`, `Document`, `DocumentChunk` (pgvector embeddings),
`AllowedDomain`, `DriveConnection`, `KnowledgeGap`.

**Policy — read before migrating:**

- **Additive only** — new nullable columns / new tables. Never
  `prisma migrate reset` or `prisma db push` against the shared DB.
- Generate without touching the DB (`prisma migrate dev --create-only` or
  `prisma migrate diff --script`), **review the SQL**, then `prisma migrate deploy`.
  `pg_dump` a backup first.
- The pgvector HNSW index `idx_chunks_vec` on `document_chunks.embedding` is
  hand-written (Prisma can't express it). If a generated migration ever contains
  `DROP INDEX "idx_chunks_vec"`, **delete that line** before applying.
- CI applies migrations in deploy with
  `docker compose run --rm backend npx -y prisma@6.19.3 migrate deploy`.

15 additive migrations live under `prisma/migrations/`.

## Testing & CI

```bash
pnpm test          # unit tests (jest, src/**/*.spec.ts)
pnpm test:e2e      # e2e (test/*.e2e-spec.ts) — needs Postgres + Redis up
pnpm lint          # eslint --fix
```

Jest config lives in `package.json` (`rootDir: src`, `@/` → `src/`); e2e uses
`test/jest-e2e.json`. CI (`.github/workflows/cicd-dev.yml`) runs on
`pgvector/pgvector:pg16` + `redis:7-alpine` service containers and must all pass:
`prisma generate` → `eslint "src/**/*.ts" "test/**/*.ts"` (no `--fix`; lints
`test/` too) → `pnpm build` → `pnpm test` → `pnpm test:e2e` → Trivy scan.
If ESLint OOMs locally: `NODE_OPTIONS=--max-old-space-size=4096 pnpm lint`.

## Conventions

Conventional Commits + branch naming, enforced by husky + commitlint +
lint-staged. See [`.github/CommitConvention.md`](.github/CommitConvention.md) and
[`.github/BranchNamingConvention.md`](.github/BranchNamingConvention.md). Feature
branch → PR → `develop`.
