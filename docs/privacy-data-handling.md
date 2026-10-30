# Prompt and data handling (SRS §9.3, §12.1, §12.2)

This document is the engineering source for the privacy notice. Statements here
must stay true in code; the referenced files are where each rule is enforced.

## What is stored, and when

| Data | Stored? | Where enforced |
| --- | --- | --- |
| Prompt text typed into the studio | Only when the user's **history** setting is on (`app_users.history_enabled`), or when the user explicitly saves it. With history off, the text exists only for the duration of the request. | `src/lib/optimiser/service.ts` (step 8), `POST /api/v1/prompts` |
| Optimised prompt | Same rule as above; stored as an immutable `prompt_versions` row with provenance `ai_optimised`. | `src/lib/services/prompts.ts` |
| Optimisation metadata (model, template version, latency, token usage, estimated cost, status, error code) | Always, as `optimisation_runs`. Never includes prompt text. | `src/lib/services/usage.ts` |
| Preference memory | Only when created by the user (`source = user_entered`) or confirmed by the user alongside feedback (`source = user_confirmed`). The server assigns the source; the client cannot claim one. | `src/lib/services/preferences.ts`, `POST /api/v1/optimisations/{id}/feedback` |
| Feedback (rating, reason, comment) | When the user submits it. Withdrawable with `DELETE`. | `src/lib/services/feedback.ts` |
| Usage ledger | Always (quota, abuse prevention, cost accounting). | `usage_events` |
| Billing state | From verified Stripe webhooks only. | `src/lib/services/billing.ts` |
| Security logs | Request ID, timing, status, model ID, usage counts. Prompt text and secrets are never logged; the logger redacts known field names as a backstop. | `src/lib/logger.ts` |

## Learning policy (FR-012, A-05)

PromptIQ never converts a prompt, a rewrite or a feedback record into a
persistent preference on its own. The only paths that create preferences are the
Preferences screen, onboarding, and the explicit "also save a preference" choice
in the feedback panel. There is no background inference job.

## External processing

Prompt text is sent to OpenAI's API from the server with PromptIQ's key
(`store: false` is set on every request so OpenAI does not retain the response
for its dashboard). OpenAI's API data retention and training policies apply and
can vary by account configuration; the privacy notice must link to OpenAI's
current data-controls page rather than promising zero retention (§9.3).

## Account deletion (FR-017)

`POST /api/v1/account/deletion` requires a session created within the last 15
minutes and the typed account email. It then, in one transaction:

1. deletes feedback, prompts (versions cascade) and preferences;
2. anonymises the profile row (`email`, `display_name` cleared; `deleted_at` set;
   history and personalisation turned off);
3. deletes the authentication user, which cascades to sessions and OAuth accounts;
4. keeps `optimisation_runs` and `usage_events` (metadata only) as the billing
   and abuse-prevention audit record, linked to the anonymised profile;
5. records the outcome in `deletion_jobs`.

Backups: encrypted database backups expire on the provider's schedule (document
the actual retention, default assumption 30 days). Deleted data may persist in
backups until then, and the UI says so.

## Retention table for the privacy notice

| Data | Retention |
| --- | --- |
| Unsaved prompt text | Not retained beyond request processing. |
| Saved prompts and versions | Until the user deletes them or the account. |
| Preferences | While they exist; the user can edit, disable or delete at any time. |
| Feedback | Until withdrawn or the account is deleted. |
| Usage and run metadata | 24 months (proposal; confirm with legal), anonymised after account deletion. |
| Security logs | 90 days (proposal). |
| Backups | 30 days (proposal; match the provider setting). |
