# Personal Prompt Library, Smart Suggestions & Token Optimisation

Every user has a private library of prompts. Prompts are saved automatically
(auto-save) or on request, analysed on demand for improvement suggestions, and
optimised in one of four modes. Every change becomes a new immutable version;
the original is never overwritten.

## How it maps onto the existing schema

Nothing is duplicated. Prompt text lives only in `prompt_versions`.

| Requirement | Implementation |
| --- | --- |
| Prompt record (title, description, category, tags, target model, favourite, archive, last used) | `prompts` (+ columns in migration 0004). Archive is `archived_at`. |
| Original text / current text | Version 1 and the newest version (`current_version_id`). Not copied onto `prompts`. |
| Current version number, original/current token counts, optimisation count and status, latest score, pending suggestions, estimated cost | Denormalised columns on `prompts`, recomputed from source tables by `refreshPromptStats()` after every write that affects them. Listings filter and sort on them with indexes. |
| Versions with change source, summary, token count, tokenizer, author | `prompt_versions` (`provenance` = change source; adds `tokenizer_version`, `created_by`, `optimisation_run_id`). Unique `(prompt_id, version_number)`. |
| Analyses | `prompt_analyses`, linked to the analysed `prompt_version_id`. |
| Suggestions | `prompt_suggestions` with status `pending → accepted / dismissed / deferred → applied`. |
| Optimisation runs (mode, target, tokens saved, reduction, cost) | `optimisation_runs` (+ `optimisation_mode`, `target_model`, `tokens_saved`, `reduction_percent`, estimated input cost before/after, `applied_suggestion_count`). |
| Auto-save setting | `app_users.history_enabled` (one switch, labelled "Auto-save prompts I optimise"). |
| Prompt preferences | `user_prompt_preferences` (model, style, answer length, token priority, default mode, use cases, learn-from-feedback). Tone/detail/format stay in `user_preferences`. |
| Provider usage of analyses | `api_usage_records.analysis_id`. |

## Saving

- **Auto-save on:** each prompt optimised in the studio is saved as version 1
  (original) and version 2 (proposal), with the target model. Only submitted
  prompts are saved, never keystrokes.
- **Auto-save off:** nothing is stored; the studio offers "Save to library".
- Default titles come from the prompt's first line. No AI call is needed to save.
- Edits always create a new version ("save as new version"); there is no
  in-place draft overwrite, so history is complete.

## Suggestion workflow

1. Open a prompt. Token counts use the target model's tokenizer.
2. **Analyse prompt** sends only that version's text (never the library) to the
   analyser with the user's prompt preferences and suggestion feedback history.
   The output is validated against `src/lib/analysis/schema.ts` before storage.
3. Re-analysing an unchanged version returns the stored result unless the user
   chooses "Analyse again" (`force`). A partial unique index prevents two
   concurrent analyses of one version.
4. The user accepts, dismisses or defers each suggestion. Suggestions needing
   facts only the user knows show a question instead of a guess.
5. **Optimise** with a mode and the selected suggestions returns a proposal and
   a token comparison. No version is written.
6. The user edits the proposal and saves it as a new version; the run is linked
   (`result_version_id`) and the suggestions become `applied`.

Analysis scores are heuristic indicators of clarity and completeness, and the UI
says so. If nothing meaningful can be improved the analysis returns "Already
well optimised".

## Optimisation modes

| Mode | Objective |
| --- | --- |
| Balanced (default) | Clarity and structure while removing unnecessary tokens. |
| Token saver | Fewest tokens that keep every requirement, constraint, identifier, example and format. |
| Quality first | Clarity and completeness over length. |
| Custom | The user's own objective (treated as data, cannot override the rules). |

## Personalisation

Only explicit inputs: prompt preferences and the user's own accept/dismiss
decisions per suggestion category. Categories dismissed repeatedly and never
accepted are raised only when high priority; token-efficiency priority changes
the priority of token suggestions. Users can view the learned counts, turn
learning off, or clear dismissed decisions. Nothing is inferred from prompt
content and no sensitive characteristics are profiled.

## Metrics (no double counting)

- **Tokens saved** (dashboard, analytics): per prompt, current version vs
  version 1, same tokenizer, counted once regardless of how many runs. Net value
  can be negative; prompts shorter and longer are reported separately.
- **Per-run figures** (history, runs by mode): each run vs the text it started
  from. Labelled as per-run and not summed into totals.
- **Estimated input-cost difference:** net tokens saved per target model × that
  model's current input price. Models without pricing are listed and the figure
  is marked incomplete.
- **Actual usage:** provider-reported usage of PromptIQ's own optimisation and
  analysis calls, per attempt.

Dashboard summaries are cached per user for 30 s and invalidated by every write
that changes library stats.

## Quotas and limits

| | Free | Pro |
| --- | --- | --- |
| Optimisations per period | 20 | 500 |
| Analyses per period | 30 | 1,000 |
| Analyses per minute | 6 | 6 |

Reusing a stored analysis consumes no quota. Background analysis exists as a
preference flag but is off and not scheduled in this release; analysis runs on
demand only.

## Privacy

- Every prompt, version, analysis, suggestion and run query is scoped by the
  authenticated user; IDs from another account return 404. RLS policies cover
  the new tables.
- Prompt text never appears in logs, analytics events or URLs (IDs only).
- Saved prompts are used only to provide features to their owner and are never
  used for training; that would need a separate explicit opt-in, which PromptIQ
  does not offer.
- Deleting a prompt deletes its versions, analyses, suggestions and estimates;
  runs and usage records keep metadata with the prompt reference cleared.
  Account deletion removes all of it. The account export includes analyses,
  suggestions and prompt preferences.
