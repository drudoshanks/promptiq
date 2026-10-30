# REST API (SRS §10)

Base path `/api/v1`. JSON in and out. Authentication is the session cookie set by
`/api/auth/*` (Better Auth); every endpoint except the billing webhook requires it.
State-changing requests from browsers must be same-origin (the `Origin` header is
checked). Every response carries `X-Request-Id`; quote it in support requests.

```
Success: { "data": { … }, "request_id": "uuid" }
Error:   { "error": { "code": "PROMPT_TOO_LONG", "message": "…", "details": { … } }, "request_id": "uuid" }
```

Send `Idempotency-Key: <opaque>` on `POST /optimisations` to make retries safe:
the same key replays the original response for 10 minutes and can never consume
quota twice.

| Method and path | Purpose | Success | Errors |
| --- | --- | --- | --- |
| `GET /me` | Profile, plan, settings, session freshness | 200 | 401 |
| `PATCH /me/preferences-settings` | `history_enabled`, `personalisation_enabled`, `display_name`, `onboarded` | 200 | 400, 401 |
| `POST /optimisations` | Optimise a prompt (body below) | 200 | 400, 413, 422, 429, 502, 503, 504 |
| `GET /optimisations/{id}` | Run metadata, saved result (if history), feedback | 200 | 404 |
| `POST /optimisations/{id}/feedback` | Rating ±1, reason, comment, optional `save_preference`, `replace` | 201 / 200 | 404, 409 |
| `DELETE /optimisations/{id}/feedback` | Withdraw feedback | 204 | 404 |
| `GET /prompts?search=&category=&tag=&page=&page_size=&include_archived=` | List with full-text search | 200 | 400 |
| `POST /prompts` | Create with 1–3 initial versions | 201 | 400, 403 (plan limit) |
| `GET /prompts/{id}` | Metadata and all versions | 200 | 404 |
| `PATCH /prompts/{id}` | `title`, `category`, `tags`, `archived` | 200 | 400, 404 |
| `DELETE /prompts/{id}` | Delete prompt and versions | 204 | 404 |
| `POST /prompts/{id}/versions` | Append an immutable version | 201 | 403, 404, 409 |
| `GET /prompts/{id}/export?format=txt|md|json&version=` | Download one version | 200 | 404 |
| `GET /preferences` | Preference memory with provenance | 200 | |
| `POST /preferences` | Create/upsert (`source` is assigned server-side) | 201 / 200 | 400 |
| `PATCH /preferences/{id}` | `preference_value`, `enabled`, `category` | 200 | 404 |
| `DELETE /preferences/{id}` | Delete | 204 | 404 |
| `GET /usage` | Period quota, usage, estimated cost, subscription | 200 | |
| `POST /exports` | Download account export JSON | 200 (file) | 429 |
| `POST /account/deletion` | Start deletion; needs fresh sign-in + `confirm_email` | 202 | 403 `REAUTH_REQUIRED`, 409 |
| `POST /billing/checkout` | Stripe Checkout URL | 200 | 409, 503 |
| `POST /billing/portal` | Stripe Customer Portal URL | 200 | 404, 503 |
| `POST /webhooks/billing` | Signed Stripe events | 200 | 400 |
| `GET /admin/metrics` | Aggregate operator metrics | 200 | 403 |

## `POST /optimisations`

```json
{
  "prompt": "Draft an email following up on an unpaid invoice…",
  "task_category": "writing",           // or "auto" (default)
  "preferences": { "tone": "professional_direct", "detail": "concise" },
  "options": { "save_to_history": true, "output_style": "structured", "max_output_tokens": 900, "title": "Invoice chaser" }
}
```

Known preference keys: `tone`, `detail`, `format`, `audience`, `language`,
`constraints`. Unknown keys are ignored. Model IDs cannot be supplied.

```json
{
  "data": {
    "optimisation_id": "uuid",
    "task_category": "writing",
    "original_prompt": "…",
    "optimised_prompt": "…",
    "change_summary": ["…"],
    "assumptions": [],
    "clarification_needed": false,
    "clarifying_questions": [],
    "quality_risks": [],
    "token_estimate": { "before": 120, "after": 88, "method": "tokenizer:o200k_base" },
    "usage": { "input_tokens": 812, "output_tokens": 140, "cached_input_tokens": 640, "source": "provider" },
    "estimated_cost_usd": 0.000483,
    "model_id": "gpt-5-mini",
    "template_version": "piq-optimiser-v1",
    "latency_ms": 2140,
    "saved_prompt_id": "uuid",
    "saved_version_ids": { "original": "uuid", "optimised": "uuid" },
    "preferences_applied": { "effective": { "tone": "professional_direct" }, "sources": { "tone": "general" } }
  },
  "request_id": "uuid"
}
```

`token_estimate` is always advisory. `usage` is the provider's measured usage for
this call when available and `"source": "unavailable"` otherwise.

## Error codes

| Code | HTTP | Client behaviour |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Sign in. |
| `FORBIDDEN` | 403 | Plan limit or operator-only; show the limit from `details`. |
| `REAUTH_REQUIRED` | 403 | Sign out and in again, then retry. |
| `VALIDATION_ERROR` | 400 | Fix the request; `details.issues` lists fields. |
| `PROMPT_EMPTY` | 400 | Ask for a prompt. |
| `PROMPT_TOO_LONG` | 413 | Show `details.limit`; allow editing. |
| `QUOTA_EXCEEDED` | 429 | Show `details.resets_at` and the upgrade path; do not retry automatically. |
| `RATE_LIMITED` | 429 | Honour `Retry-After`; bounded backoff only. |
| `OPTIMISATION_REFUSED` | 422 | Show the refusal state; keep the original. |
| `PROVIDER_TIMEOUT` | 504 | Offer retry; nothing was stored. |
| `PROVIDER_UNAVAILABLE` | 502 | Temporary issue; honour `Retry-After` if present. |
| `INVALID_MODEL_OUTPUT` | 502 | Offer retry. |
| `SPEND_CAP_REACHED` | 503 | Try later. |
| `NOT_FOUND` | 404 | Not found or not owned (indistinguishable by design). |
| `CONFLICT` | 409 | Refresh and retry deliberately (duplicate feedback, used idempotency key). |
| `BILLING_UNAVAILABLE` | 503 | Billing not configured. |
| `INTERNAL_ERROR` | 500 | Show the request ID. |
