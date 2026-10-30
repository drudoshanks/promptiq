# PromptIQ

A prompt optimisation and export SaaS for individual AI users, built to the
PromptIQ SRS v1.0 (30 October 2026). Paste a prompt, get a structured rewrite
from the official OpenAI API, compare it word by word with the original, edit,
accept, export as TXT/Markdown/JSON, and keep every version. Preferences are
only ever created by the user; token counts are labelled as estimates; the
final prompt is never executed.

## Stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Web and API | Next.js 16 (App Router, route handlers), React 19, TypeScript strict | `src/app`, `src/components` |
| Database | PostgreSQL 14+ via Drizzle ORM, plain SQL migrations | `db/migrations`, `src/lib/db` |
| Auth | Better Auth: email + password with recovery, Google and GitHub OAuth | one-file integration in `src/lib/auth/auth.ts`; the app only calls `getCurrentUser()` |
| Optimiser | Official `openai` SDK, Responses API with Structured Outputs, behind a provider adapter with a deterministic `mock` mode | `src/lib/providers`, `src/lib/optimiser` |
| Billing | Stripe Checkout + Customer Portal, signed and idempotent webhooks | `src/lib/services/billing.ts` |
| Styling | Tailwind CSS 4 with a small token set | `src/app/globals.css` |
| Tests | Vitest (unit + embedded PostgreSQL via PGlite), Playwright (E2E) | `tests/` |
| Evaluation | Golden dataset + deterministic invariants + report comparison | `eval/` |

## Run it locally

```bash
cp .env.example .env.local        # defaults: mock optimiser, local Postgres
docker compose up -d db           # PostgreSQL 16 on localhost:5432
npm install
npm run db:migrate
npm run dev                       # http://localhost:3000
```

Sign up with any email and a 10+ character password (no email service is needed
locally: password-reset links print to the server log). The mock optimiser
rewrites deterministically and costs nothing. To use the real provider:

```
OPTIMISER_PROVIDER=openai
OPENAI_API_KEY=sk-…
OPTIMISER_MODEL=gpt-5-mini          # server-side only; verify current IDs/prices
```

Useful commands:

```bash
npm run check        # lint + typecheck + tests
npm test             # 68 unit/database tests, no services required
npm run build        # production build (standalone server)
npm run eval         # evaluation harness; writes eval/reports/*.json
npm run test:e2e     # Playwright critical flows (needs a database)
```

## How the pieces map to the SRS

| SRS | Implementation |
| --- | --- |
| §7 optimisation pipeline and rules | `src/lib/optimiser/service.ts` (pipeline), `instructions.ts` (versioned template `piq-optimiser-v1`), `schema.ts` (§7.3 contract, validated on the way back) |
| §8 architecture | Modular monolith: route handlers → services → Drizzle. Provider adapter interface in `src/lib/providers/types.ts`; circuit breaker, bounded retries, timeouts in `openai.ts` |
| §9 schema | `db/migrations/0001_init.sql` (all tables from §9.2 plus the auth tables), `0002_row_level_security.sql` (defence in depth), `src/lib/db/schema.ts` |
| §10 REST API | `src/app/api/v1/**`; conventions, envelope and error codes in `src/lib/api`; reference in `docs/api.md` |
| §11 screens | Landing, sign-in/up/reset, onboarding, overview, studio with comparison, library + versions, preference memory, usage/plan, settings/privacy, minimal admin |
| §12 security | Server-held secrets (`server-only`), ownership checks on every query, origin check on mutations, per-user/IP rate limits, global spend cap, redacted logs, signed webhooks, fresh re-auth for deletion |
| §13 testing | `tests/unit`, `tests/db` (ownership/IDOR, versioning, quota, idempotency, failure paths, deletion, billing), `tests/e2e`, `eval/` |
| §14–16 delivery | `.github/workflows/ci.yml`, `Dockerfile`, `docs/deployment.md`, `docs/runbooks.md` |
| §17 cost | `src/lib/cost.ts` with the price table in `src/lib/config/models.ts`; estimates are labelled everywhere |

## Decisions and deviations from the SRS baseline

- **Auth vendor.** The SRS leaves the vendor open (A-04). Better Auth was chosen
  over Auth.js v5 (still a beta tag, and its maintainers now point new projects
  to Better Auth) because it covers FR-001 fully, including password recovery,
  and keeps the app runnable with no third-party account. Swapping to a hosted
  provider (Clerk, Auth0) touches `src/lib/auth/*` only.
- **`citext` / `pgcrypto`.** Email is a normalised lower-case `TEXT` column and
  IDs use the built-in `gen_random_uuid()`, so the schema needs no extensions
  (the SRS allows this in its §9.2 implementation notes).
- **Extra columns.** `app_users.onboarded_at`, `optimisation_runs.task_category`,
  `prompt_versions.token_estimate(_method)`, `feedback.updated_at`,
  `webhook_events.error_code`. All additive.
- **Account export** returns the JSON document synchronously (200) rather than a
  202 job: per-account data is small in the MVP. The route and format are kept
  so an asynchronous implementation is a drop-in change.
- **Idempotency replay** is held in process memory for 10 minutes; the durable
  guarantee (never consume quota twice) is the unique key on `usage_events`.
- **Rate limiting** is in-process (single instance). The database ledger still
  enforces quotas across instances; move the limiter to Redis before scaling out.
- **Deletion** runs synchronously inside the request but is tracked in
  `deletion_jobs` exactly as the SRS describes.
- **Quota rejections** are written as zero-unit `usage_events` (`quota_rejected`)
  so the admin screen can show quota-abuse signals (FR-020) without storing prompts.

## Evaluation harness

`npm run eval` runs `eval/dataset.jsonl` (22 seed cases: vague prompts, already
good prompts, hard constraints, code and stack traces, exact identifiers, a
Spanish prompt, instruction-override attempts) through the configured provider
and checks deterministic invariants: identifiers preserved, no invented URLs,
category agreement, override attempts flagged, no self-reference. Reports land
in `eval/reports/`; pass `--baseline <report>` to compare template versions.
With the mock provider 18/22 pass; the four failures are the mock's known
limits (no language detection, keyword classification, no clarification
logic) and serve as a floor for the real model. Grow the dataset to the 100+
cases the SRS asks for before launch, and fill the `review` fields by hand: the
harness measures regressions and token deltas, not quality.

## Status against the launch checklist (§19)

Done in code: scope limits (no execution, no BYOK, no vector DB), server-held
secrets, quota/rate/spend controls, cross-user authorisation tests, history and
preference behaviour tests, export round-trip tests, health endpoint, runbooks.

Needs a human before launch: product-owner sign-off on A-01..A-10, vendor
accounts (OpenAI key, Stripe products, OAuth apps, email), the legal review of
the privacy notice and terms, the 100-case evaluation baseline with human
grading, backup/restore drill on the chosen database provider, and the current
OpenAI model/price verification noted in `src/lib/config/models.ts`.
