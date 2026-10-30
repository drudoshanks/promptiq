# Token & Cost Estimation Engine

PromptIQ counts the tokens in a prompt, compares the original with the
optimised version, estimates what a request would cost on a chosen model, and
records the actual usage the provider reports for PromptIQ's own API calls.
Estimates and actual usage are stored in separate tables and labelled
separately everywhere in the UI.

## What the numbers mean

| Number | Source | Stored in | Label in UI |
| --- | --- | --- | --- |
| Token count of a text | `js-tiktoken` with the selected model's encoding (`o200k_base` for every supported model) | `token_estimates` (only at optimisation and export) | **estimate** |
| Estimated input / output / total cost | Token count × the pricing snapshot in force, plus an *assumed* answer length | `token_estimates` | **estimate** |
| Actual tokens and cost of PromptIQ's optimisation call | `usage` returned by the OpenAI Responses API, per attempt | `api_usage_records` (per attempt), summed on `optimisation_runs` | **actual** |

**Limitations, stated in the UI and API:**

- A count covers exactly the supplied text. Message wrappers, system
  instructions, conversation history, tools and attachments add tokens the model
  also bills, so a real request uses more input tokens than the count shows.
- Output length is an assumption picked by the user (Short ≈150, Medium ≈500,
  Long ≈1,500 tokens; `src/lib/config/estimates.ts`), not a prediction.
- PromptIQ cannot see the usage of a prompt the user runs in ChatGPT or any
  other app. The only actual usage it knows is its own optimisation call, which
  includes PromptIQ's instructions and is therefore larger than the prompt.
- A shorter prompt is not automatically better or cheaper overall; the UI says
  so next to every comparison.

## Supported models

`src/lib/config/models.ts` is the allowlist (mapping version `2026-10-30`).
Counting for any other model is refused with `422 UNSUPPORTED_MODEL`; the engine
never falls back to a different tokenizer. Dated snapshots such as
`gpt-5-mini-2025-08-07` resolve to their base model. Each stored estimate records
`tokenizer_version` (`js-tiktoken@1.0.21/o200k_base/mapping-2026-10-30`); the
package is pinned exactly so counts are reproducible, and a test fails if the
installed version and the recorded one diverge.

Character counts are Unicode code points (an emoji counts as one character).

## Pricing

Rates live in the `model_pricing` table, never in application code. Each row has
provider, model, `pricing_version`, currency, input / cached-input / output price
per 1M tokens, optional `extra_prices`, `effective_from`/`effective_to`, `source`
and `verified_at`. A trigger rejects overlapping periods for the same model, and
a partial unique index allows only one open-ended (current) row per model.

Seeded on 2026-10-30 from OpenAI's model pages (standard tier, USD per 1M):

| Model | Input | Cached input | Output |
| --- | --- | --- | --- |
| gpt-5-mini | 0.25 | 0.025 | 2.00 |
| gpt-5-nano | 0.05 | 0.005 | 0.40 |
| gpt-4o | 2.50 | 1.25 | 10.00 |

The other supported models (GPT-5, GPT-5.4 family, GPT-4.1 family, GPT-4o mini)
are counted but show **"no pricing"** until an operator records a rate checked
against OpenAI's own pricing page:

```bash
npm run pricing:add -- --model gpt-5.4-mini --input 0.75 --cached 0.075 --output 4.5 \
  --source https://developers.openai.com/api/docs/models/gpt-5.4-mini --effective-from 2026-11-01
```

The script closes the model's current row at `--effective-from`, so estimates
made earlier keep resolving to the rate they used (`pricing_version` is stored
with every estimate and usage record). Pricing whose `verified_at` is older than
90 days (`PRICING_STALE_AFTER_DAYS`) is shown as "pricing may be out of date".
Lookups are cached in-process for 60 seconds.

Costs are computed and stored with 10 decimal places (`NUMERIC(16,10)`), because
a short prompt on a small model costs well under a millionth of a dollar. The
run-level total on `optimisation_runs.estimated_cost_usd` keeps its original 6
places; `api_usage_records` is the precise ledger.

## Actual usage and retries

The OpenAI adapter disables the SDK's internal retries and runs its own loop, so
every request OpenAI saw is one **attempt**:

- at most one transport retry (timeout, connection error, 5xx, or a 429 with a
  `Retry-After` of 5 s or less), with jittered backoff;
- at most one repair attempt after malformed structured output.

Each attempt becomes one `api_usage_records` row keyed `(run_id, attempt)`, so
re-recording is a no-op and nothing is double-counted. Attempts for which the
provider returned no usage (timeouts, connection errors) are stored with
`usage_reported = false`, zero tokens and a null cost: never a guess. OpenAI may
still bill part of a timed-out request; that cannot be known from the API
response. The logical operation (`optimisation_runs`) holds the summed usage,
`attempt_count` and `pricing_version`. Quota is consumed once per logical
operation, and an idempotent replay creates no new rows.

## When estimates are stored

Never while typing. The studio counts through the API with a 300 ms debounce
(and a 120 requests/minute per-user limit) without writing anything. Rows are
written:

1. when an optimisation completes: one `original` and one `optimised` estimate
   for the target model, linked to the run and, if history is on, to the versions;
2. at export: one `final` estimate of exactly the text being exported (studio
   and library). The TXT export is the counted text byte for byte.

`token_estimates` never contains prompt text. It is deleted with the account;
`api_usage_records` is kept, like `optimisation_runs`, as anonymised billing and
abuse metadata.

## API

See `docs/api.md`: `POST /api/v1/token-estimates`, `GET /api/v1/models`,
`GET /api/v1/usage/records`, and the `estimate` / `actual_usage` fields on
`POST /api/v1/optimisations` and `GET /api/v1/optimisations/{id}`.
