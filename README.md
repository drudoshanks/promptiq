# PromptIQ by iMarwar

A prompt optimisation and export SaaS for individual AI users, built by
[iMarwar](https://imarwar.com/) to the PromptIQ SRS v1.0 (30 October 2026).
Paste a prompt, get a structured rewrite from an open-source model or the
OpenAI API, or break a big prompt into step-by-step prompts. Compare it word by
word with the original, edit, accept, export as TXT/Markdown/JSON, and keep
every version. Preferences are only ever created by the user, token counts are
labelled as estimates, and the final prompt is never executed.

## Brand and design

- **Brand:** PromptIQ is branded as a product of iMarwar.
- **Brand assets:** in `public/brand/`.
  - `imarwar-logo.svg` and `imarwar-logo-white.svg` (for dark backgrounds);
  - `imarwar-mark.svg`, the dot mark, also used as `public/favicon.svg`.
- **Company details:** shown in the footer and credits; set in `src/components/brand.tsx` (`IMARWAR`).
- **Design tokens:** iMarwar orange `#FC7905` / `#FD8A22`, a warm off-white
  ground, near-black ink, and indigo for estimates. Radii and shadows are set
  there too. They live in `src/app/globals.css` (`@theme`), so a recolour is a
  one-file change.
- **Fonts:** Plus Jakarta Sans and IBM Plex Mono, self-hosted through
  `@fontsource`. No requests go to Google Fonts.

## Stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Web and API | Next.js 16 (App Router, route handlers), React 19, TypeScript strict | `src/app`, `src/components` |
| Database | PostgreSQL 14+ via Drizzle ORM, plain SQL migrations | `db/migrations`, `src/lib/db` |
| Auth | Better Auth: email + password with recovery, Google and GitHub OAuth | one-file integration in `src/lib/auth/auth.ts`; the app only calls `getCurrentUser()` |
| Optimiser | Provider adapter: open-source models over any OpenAI-compatible chat API (Ollama, vLLM, Groq, OpenRouter ...), the OpenAI Responses API, or the built-in rule-based engine | `src/lib/providers`, `src/lib/optimiser` |
| Billing | Stripe Checkout + Customer Portal, signed and idempotent webhooks | `src/lib/services/billing.ts` |
| Styling | Tailwind CSS 4 with a small token set | `src/app/globals.css` |
| Tests | Vitest (unit + embedded PostgreSQL via PGlite), Playwright (E2E) | `tests/` |
| Evaluation | Golden dataset + deterministic invariants + report comparison | `eval/` |

## Run it locally

**macOS, one command** (installs Node 22 and PostgreSQL 16 with Homebrew, no
Docker needed; safe to re-run):

```bash
bash scripts/setup-mac.sh       # or run the downloaded script before cloning
cd ~/Desktop/promptiq && npm run dev   # http://localhost:3000
```

**Any OS, by hand** (uses Docker for PostgreSQL):

```bash
cp .env.example .env.local        # defaults: mock optimiser, local Postgres
docker compose up -d db           # PostgreSQL 16 on localhost:5432
npm install
npm run db:migrate
npm run dev                       # http://localhost:3000
```

Sign up with any email and a 10+ character password (no email service is needed
locally: password-reset links print to the server log). The default `mock`
provider is the built-in rule-based engine: no AI model, no cost.

To use a free, open-source model on your own machine with
[Ollama](https://ollama.com):

```bash
brew install ollama && ollama serve        # or install the Ollama app
ollama pull qwen2.5:7b                     # ~4.7 GB; any chat model works
```

```
OPTIMISER_PROVIDER=open
OPEN_MODEL=qwen2.5:7b
```

The same setting works with LM Studio, vLLM, llama.cpp or a hosted service
(Groq, OpenRouter, Together): set `OPEN_MODEL_BASE_URL` and `OPEN_MODEL_API_KEY`.
If the model is unreachable, PromptIQ falls back to the rule-based engine. Full
guide: [`docs/open-models.md`](docs/open-models.md). To use OpenAI instead, set
`OPTIMISER_PROVIDER=openai`, `OPENAI_API_KEY` and `OPTIMISER_MODEL`.

Useful commands:

```bash
npm run check        # lint + typecheck + tests
npm test             # unit, database, route and component tests; no services required
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

## Token & cost estimation

Counts tokens per model (exact `o200k_base` tokenizer, no LLM call), compares
original and optimised prompts, estimates cost from versioned database pricing,
and records the provider's actual usage for every attempt PromptIQ makes. The
full design, limitations and pricing operations are in
[`docs/token-cost-estimation.md`](docs/token-cost-estimation.md). Add a verified
rate with `npm run pricing:add`.

## Personal prompt library

Auto-saved or manually saved prompts with immutable versions, AI analysis with
per-version suggestions you accept, dismiss or defer, four optimisation modes
that produce reviewable proposals (never overwriting the original), dashboards
for suggestions, history and token/cost analytics, and explicit prompt
preferences. Design, metrics definitions and privacy rules:
[`docs/prompt-library.md`](docs/prompt-library.md).

## Prompt intelligence

The **Studio** (`/app/studio`, also embedded on every saved prompt; the old
Quick studio and `/app/intelligence` now open it) classifies the task,
scores completeness with a configurable weighted rubric, extracts the prompt's
requirements, lists missing information, and ranks suggestions by your own
feedback. It generates detailed, balanced, token-saver, quality-first or custom
revisions, checks every requirement survived (repairing drops), and compares
tokens and cost before saving a new version. Revisions apply your saved
preferences (unless the prompt says otherwise), show a live token count as you
type, and, when auto-save is on, store the original and first proposal in My
prompts. **Break into smaller prompts** splits a big request into a short
sequence of self-contained step prompts. Each step comes with how to run it,
what a good answer has, and checks before moving on. The sequence also has a
run order (including which steps can run in parallel), usage advice, and a check
that every requirement is carried by a step. Steps can be copied, downloaded as
Markdown, or saved to My prompts as a tagged set. Algorithms, API, data model
and evaluation: [`docs/prompt-intelligence.md`](docs/prompt-intelligence.md).
Evaluate with `npm run eval:intelligence`.

## UPI payments (India)

Users buy Pro by paying the business UPI ID (QR code or copy) and submitting
their transaction reference; an administrator verifies each payment against the
bank statement or UPI merchant app, and only that activates the subscription
(transactionally, exactly once). No payment gateway. Set `UPI_VPA`,
`UPI_PAYEE_NAME` and `ADMIN_EMAILS`, run `npm run db:migrate`, and schedule
`npm run payments:maintenance`. Details: [`docs/upi-payments.md`](docs/upi-payments.md).

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
