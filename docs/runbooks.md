# Operational runbooks (SRS §16.3)

Every procedure assumes you have: access to the production logs (JSON lines with
`request_id`), the database, the Stripe dashboard and the OpenAI dashboard.
Never query or log prompt text while following these runbooks; aggregate first.

## 1. OpenAI API outage or elevated rate limits

Symptoms: `PROVIDER_UNAVAILABLE` / `PROVIDER_TIMEOUT` rise on `/admin`, logs show
`provider connection error`, `provider rate limited` or `circuit_open`.

1. Confirm on https://status.openai.com and in the OpenAI dashboard.
2. The circuit breaker (`src/lib/providers/circuit-breaker.ts`) opens after 5
   consecutive transport failures for 30 s per instance; users see a safe error
   and their text is preserved. No action is needed for short blips.
3. For a sustained outage, lower `OPTIMISER_TIMEOUT_MS` (e.g. 10000) so requests
   fail fast, and consider a banner on the studio page.
4. If the provider is rate limiting us specifically, reduce `RATE_LIMITS.optimisePerMinute`
   (`src/lib/api/rate-limit.ts`) and redeploy; check the OpenAI usage tier.
5. After recovery, watch `failure_rate` on `/admin` return to baseline.

## 2. Unexpected spend spike

Symptoms: `global daily spend cap reached` in logs, `SPEND_CAP_REACHED` errors,
OpenAI dashboard spend above forecast.

1. The hard stop is `GLOBAL_DAILY_SPEND_CAP_USD` (estimated spend, UTC day). When
   reached, optimisation pauses for everyone; other features keep working.
2. Inspect `/admin` → "Heaviest accounts" (opaque IDs) and
   `SELECT user_id, count(*), sum(estimated_cost_usd) FROM optimisation_runs WHERE created_at > now() - interval '1 day' GROUP BY 1 ORDER BY 3 DESC LIMIT 20;`
3. For scripted abuse: set the account's `plan_code` to `free` if it was wrongly
   upgraded, or add a temporary per-account block by setting `deleted_at` only
   after the incident lead approves (this logs the user out and blocks the API).
4. If the spike is organic, raise the cap deliberately and verify the price table
   in `src/lib/config/models.ts` still matches the OpenAI pricing page.

## 3. Leaked API key (OpenAI, Stripe or AUTH_SECRET)

1. Rotate immediately: create a new key in the provider dashboard, update the
   secret manager, redeploy, then revoke the old key. For `AUTH_SECRET`, rotating
   signs every user out; announce it.
2. Inspect provider access logs for unexpected usage during the exposure window.
3. Search the repository history and CI logs for the value; purge if committed.
4. Assess exposure and notify affected parties as legally required. Record the
   incident timeline.

## 4. Billing webhook failure

Symptoms: `/admin` shows failed or unprocessed webhook events; a paying user is
still on `free`; Stripe dashboard shows non-2xx responses.

1. Check the Stripe dashboard → Developers → Webhooks for the failing event and
   our response body (the API returns `VALIDATION_ERROR` for bad signatures).
2. If `STRIPE_WEBHOOK_SECRET` is wrong, fix it and redeploy.
3. Replay the event from Stripe. Processing is idempotent: `webhook_events`
   stores each `provider_event_id` once; failed rows are retried on replay.
4. Reconcile manually if needed: fetch the subscription in Stripe and compare with
   `SELECT * FROM subscriptions WHERE provider_subscription_id = 'sub_…';`.
   `applySubscription` can be invoked from a maintenance script with the Stripe
   subscription object to rewrite state.

## 5. Account deletion failure

Symptoms: `deletion_jobs.status = 'failed'`, user reports deletion did not go
through.

1. `SELECT * FROM deletion_jobs WHERE status = 'failed';` and read `error_code`.
2. Fix the cause (most likely a foreign-key or connectivity issue), then re-run the
   request: the API rejects a new request only while a job is `pending`/`running`/
   `completed`; a `failed` job can be retried by calling the endpoint again (the
   user must still be signed in) or by invoking `requestAccountDeletion` from a
   maintenance script.
3. Never log or print the deleted content while debugging.

## 6. Suspected cross-user data exposure

1. Contain: disable the affected route (return 503 via a feature flag or deploy a
   stub), or take the application offline if the scope is unknown.
2. Preserve evidence: snapshot the database and copy the logs for the window; do
   not run clean-up before the snapshot exists.
3. Investigate using request IDs and `optimisation_runs` / `prompts` ownership
   joins. Row-level security policies (migration 0002) only help if the runtime
   role is not the table owner; confirm the deployment follows docs/deployment.md.
4. Fix, add a regression test under `tests/db/ownership.test.ts`, deploy.
5. Notify affected users and authorities as required; write the post-mortem.

## 7. Restoring from backup

1. Managed PostgreSQL providers offer point-in-time recovery; restore to a new
   instance, never over the live one.
2. Run `npm run db:migrate` against the restored instance (idempotent).
3. Smoke test with `GET /api/health` and one mock optimisation on staging.
4. Switch `DATABASE_URL`, redeploy, and verify a sample of recent prompts exist.
   Deleted accounts may reappear if the backup predates deletion: re-run their
   deletion jobs (`deletion_jobs` is restored too).
