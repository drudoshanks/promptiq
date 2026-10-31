# Prompt Intelligence Engine

Turns a short or vague prompt into a clear, structured one while preserving the
user's intent. It analyses the task, scores completeness, explains what is
missing, generates detailed or token-efficient revisions, checks that every
requirement survived, and learns from the user's explicit feedback.

Everything is reviewable. No revision is saved until the user accepts it, and
the original version is never overwritten.

## Workflow

1. The user enters a prompt in **Prompt intelligence** (`/app/intelligence`),
   or opens one from **My prompts** (the same workspace is embedded on every
   prompt page).
2. **Analyse** classifies the task, scores the prompt against the rubric,
   extracts its requirements, lists missing information, and ranks
   suggestions.
3. The user answers clarification questions, edits or removes the labelled
   assumptions, and selects suggestions.
4. **Generate detailed prompt** or **Optimise prompt** (in the chosen mode, with
   an optional token budget) produces a proposal.
5. The proposal is validated against the original's requirements. Tokens and
   estimated input cost are counted before and after.
6. The user compares the two versions side by side or as a diff, can edit the
   result (and re-check requirements), generate another version, copy or
   export it, and **Accept and save** it as a new version.
7. Explicit feedback (accepted, dismissed or deferred suggestions, the chosen
   mode, saved revisions, restored versions, helpful/unhelpful ratings) shapes
   how future suggestions are ranked for that user.

## Modules

The modules live in `src/lib/intelligence/` (storage-free and unit-tested); the
service layer is `src/lib/services/intelligence.ts`.

| Spec module | Implementation |
| --- | --- |
| IntentClassifier | `classifier.ts`: weighted keyword rules and confidence, with a model check (`analyseIntent`) only when the rules are ambiguous. |
| PromptCompletenessScorer | `scorer.ts`: rubric weights in `src/lib/config/intelligence.ts`. |
| PromptStructureBuilder | `structure.ts` (intermediate representation and renderer) and `templates.ts` (category templates). |
| PromptSuggestionEngine | `suggestions.ts`: rule suggestions merged with model suggestions. |
| PromptOptimisationEngine | `compress.ts` (guarded deterministic pipeline) and `engine.ts` (generate → validate → repair loop). |
| RequirementPreservationValidator | `requirements.ts`. |
| TokenEstimator / CostEstimator | The existing `src/lib/tokens.ts` and `services/estimates.ts` (`compareTexts`). No LLM is called to count tokens. |
| FeedbackRankingService | `ranking.ts`, with counts from `services/prompt-preferences.ts#getRankingContext`. |

### Model calls

Model calls go through the existing provider adapter (OpenAI Responses API,
structured outputs). There are three operations:

- `analyseIntent`: classification, requirements, suggestions and missing
  information in one call.
- `revisePrompt`: one revision in the chosen mode.
- `compareRequirements`: a meaning check, run only for requirements the
  deterministic pass could not confirm.

Every response is re-validated server-side (`schemas.ts`). Timeouts, one
transport retry, one repair attempt for malformed output, a circuit breaker and
per-attempt usage records are inherited from the adapter.

Calls are avoided where possible:

- Analysis skips the model for short prompts whose rule-based classification
  is confident.
- Re-analysing an unchanged saved version reuses the stored result.
- Re-analysing unsaved text within 10 minutes is served from a cache keyed by a
  hash, never by the text.
- Token-saver mode tries the deterministic pipeline first and calls no model
  if that is enough.

The local provider (`OPTIMISER_PROVIDER=mock`) implements the same three
operations deterministically, for development, tests and evaluation.

### Prompt injection

System instructions are fixed per template version and never contain user
text. The prompt travels as the `prompt` field of a JSON document, described as
untrusted data. Embedded override attempts ("ignore previous instructions",
"reveal your system prompt", "rate this 100") are flagged as a high-priority
clarity suggestion and otherwise treated as text. Only the one prompt version
being analysed is sent, plus preference fields the user set themselves
(`preferencesForModel`), never the library.

## Algorithms

### 1. Intent classification

The categories are:

- `software_development`
- `writing_communication`
- `research_analysis`
- `business_strategy`
- `marketing_seo`
- `data_analysis`
- `education_tutoring`
- `creative_ideation`
- `project_planning`
- `general`
- `unknown`

Each category has strong cues (weight 2) and weak cues (weight 1). Ties go to
the more specific category, so "write a short story" is creative rather than
writing.

Confidence is `0.35 + 0.08·min(top score, 5) + 0.25·margin`, where margin is
`(top − second) / top`, capped at 0.95. If it falls below 0.6
(`ruleConfidenceThreshold`), the result is marked ambiguous and the model
decides. Weak evidence returns `general`, or `unknown` for prompts under four
words; nothing is forced.

The classification returns:

- the primary and optional secondary category;
- the objective;
- the confidence;
- the template;
- missing information;
- the method used (`rules`, `model` or `user`).

The user can override the category at any time.

### 2. Completeness score

```
quality_score = 100 · Σ wᵢ·sᵢ     (weights normalised over applicable dimensions)
```

| Dimension | Weight |
| --- | ---: |
| Objective clarity | 25 |
| Context completeness | 20 |
| Instruction specificity | 20 |
| Constraints and requirements | 15 |
| Output format clarity | 15 |
| Examples or reference material | 5 |

Each dimension scores 0–1 and returns its evidence. The examples dimension
applies only to writing, marketing, creative and data tasks, or when the prompt
already includes an example; otherwise its weight is redistributed, so prompts
are not penalised for lacking examples that would not help.

The output also includes:

- missing elements and the top three priorities (by weight × shortfall);
- `sufficiently_clear`: score ≥ 70 and no major dimension below 0.4;
- `needs_more_context`.

The UI states that the score is a heuristic indicator of how completely the
prompt states itself, not a prediction of answer quality.

### 3. Structured construction

`buildIntent` produces a validated intermediate representation:

- `task_type`
- `objective`
- `context`
- `requirements`
- `constraints`
- `output_format`
- `missing_information`
- `assumptions`
- `must_preserve`

Answers to clarification questions become known facts. Unanswered gaps become
labelled assumptions ("Payment provider: not specified. If it matters, ask
before choosing…") or `[Add: …]` placeholders, never invented specifications.
Accepted suggestions are rendered as labelled gaps (for example
`[Add: format and length…]`), never pasted in as advice text.

Templates (`templates.ts`) cover coding, writing, research, business, data,
planning and general. A template is an ordered list of sections (heading,
source field, guidance, `detailedOnly`, `missingKey`), so a new category is a
new entry in that list.

### 4. Modes

| Mode | Behaviour |
| --- | --- |
| `detailed` | Full template brief with deliverables and acceptance criteria where they apply. |
| `balanced` | Light structure and no padding; gaps become one "ask first" line. |
| `token_saver` | Shortest safe version; deterministic first. |
| `quality_first` | Explicit output structure and a self-check line; clarity over length. |
| `custom` | Optimises for an objective the user describes. |

The UI does not claim that longer or shorter prompts perform better.

### 5. Token-aware optimisation

The steps, in order:

1. Remove repeated or equivalent sentences (normalised equality, or Jaccard
   similarity ≥ 0.85).
2. Remove filler phrases.
3. Simplify verbose phrases.
4. Merge equivalent list items.
5. Collapse whitespace.

Code blocks, quoted text, URLs and numbers are never touched. After each step
the tokens are recounted and the requirements are re-validated; a step that
would lose an essential requirement is reverted.

A token budget is a ceiling. If it cannot be met safely, the response explains
by how much it was missed and offers alternatives (raise the budget, remove
requirements, move reference material elsewhere). Requirements are never
dropped to meet it.

`tokens_saved = original − revised` and
`reduction_percent = original > 0 ? saved / original · 100 : 0`. Negative values
are shown as "tokens added".

### 6. Requirement preservation

`extractRequirements` finds the following, with character offsets:

- objective
- functional requirements
- technical constraints (technologies)
- specific values (numbers with units, quoted text, URLs)
- output format
- length
- tone
- restrictions
- conditions
- examples

Repeated instructions count once.

`validatePreservation` then checks each requirement in four steps:

1. **Exact values must appear.** A number whose unit stays the same but whose
   value changes is marked as contradicted.
2. **Restrictions must keep their negation.**
3. **Term overlap decides the rest:** at least 0.75 counts as preserved, 0.4 to
   0.75 as changed, and below 0.4 as missing.
4. **Unresolved items optionally get a semantic check.** The semantic pass can
   never override an exact-value mismatch.

It also reports new assumptions in the revision, self-contradictions
(short versus detailed, formal versus casual, minimum above maximum), and an
overall status of `passed`, `needs_review` or `failed`.

The engine feeds dropped requirements back to the next revision, up to 3 rounds
(`maxIterations`). If they are still missing after that, it re-adds them
verbatim under "Also required:" and flags the result as `repaired`. Every
report carries the disclaimer that automated checks cannot guarantee semantic
equivalence.

### 7. Suggestions

Rule suggestions come from:

- dimension gaps;
- material missing information;
- redundancy, with a measured token impact;
- filler, with a measured token impact;
- contradictions;
- embedded instructions.

Model suggestions of other kinds are merged in.

The kinds are:

- `clarity`
- `missing_context`
- `specificity`
- `output_format`
- `constraints`
- `redundancy`
- `token_efficiency`
- `contradictions`
- `examples`
- `task_specific`

Each suggestion includes:

- an ID;
- its kind and priority;
- a title and explanation;
- the recommended change;
- the expected benefit;
- the signed token impact, when measurable;
- whether clarification is needed, and the question to ask;
- its status;
- for saved prompts, the analysed version it applies to.

The result is capped at 8. A clear prompt with only polish-level suggestions
returns "Already well optimised".

### 8. Feedback ranking

```
recommendation_score = (0.45·acceptance + 0.30·preference_match + 0.25·task_relevance) / Σw
```

- **Acceptance** is Beta-smoothed toward a neutral 0.5 with prior strength 4,
  then blended by volume (full weight at 10 events). Two dismissals barely move
  it; thirty do. Per-task counts are used once there are at least three.
- **Preference match** comes from the user's chosen helpful categories, token
  priority, output format and prompt style.
- **Task relevance** is a per-category matrix; contradictions and clarity are
  always relevant.

Final order = 0.5·priority + 0.5·recommendation score. Each suggestion carries a
plain-language explanation of its ranking. Turning off "Learn from my
suggestion decisions" uses the neutral prior.

## API

All endpoints require a session, validate ownership, apply input limits and rate
limits, and use the standard envelope and error codes.

| Endpoint | Purpose | Rate limit |
| --- | --- | --- |
| `POST /api/v1/prompt-intelligence/analyse` | Classify, score and suggest. Saved version: stored (201), or reused (200). Unsaved text: not stored; repeats within 10 minutes come from the cache (200). | 10/min |
| `POST /api/v1/prompt-intelligence/generate` | Revision, default mode `detailed`. | 8/min |
| `POST /api/v1/prompt-intelligence/optimise` | Revision, default mode is the user's preferred mode; `token_budget` optional. | 8/min |
| `POST /api/v1/prompt-intelligence/validate` | Requirement check and token comparison for an edited revision. | 30/min |
| `POST /api/v1/prompt-intelligence/feedback` | Ratings and suggestion feedback for unsaved analyses (categories only). | 20/min |
| `GET /api/v1/prompts/{id}/suggestions`, `PATCH /api/v1/suggestions/{id}` | Existing; status changes now write feedback events. | |
| `GET/POST /api/v1/prompts/{id}/versions`, `POST /api/v1/prompts/{id}/restore/{version_id}` | Existing; saving a revision and restoring a version write feedback events. | |
| `GET/PATCH /api/v1/preferences/prompts` | Adds `prompt_style`, `task_categories`, `helpful_suggestion_categories` and the `detailed` default mode. | |

The request body for `analyse`, `generate` and `optimise`:

- `prompt_text`, or `prompt_id` (optionally with `version_id`; adding
  `prompt_text` analyses an edited draft of that prompt);
- `category`;
- `target_model`;
- for `generate` and `optimise` also: `mode`, `token_budget`, `assumptions[]`,
  `answers{key: text}`, `suggestion_ids[]` (saved suggestions),
  `accepted_changes[{category, text}]` (unsaved suggestions) and
  `custom_objective`.

Error codes:

- `401`: not signed in;
- `400 VALIDATION_ERROR`: invalid body;
- `404 NOT_FOUND`: the resource belongs to someone else, or doesn't exist;
- `409 CONFLICT`: the analysis is already running, or the suggestion was
  already applied;
- `413 PROMPT_TOO_LONG`;
- `422 UNSUPPORTED_MODEL`;
- `429 QUOTA_EXCEEDED` or `RATE_LIMITED`;
- `503`: the provider is unavailable.

The revision response contains:

- `revision_id`, `mode`, `engine` (`local`/`model`) and `category`;
- `template`, `original_prompt`, `revised_prompt` and `intent`;
- `preservation` (checks with text, status and notes, plus new assumptions,
  contradictions and the disclaimer);
- `key_improvements`, `assumptions_introduced`, `clarification_questions`,
  `iterations`, `repaired`, `compression_steps` and `budget`;
- `estimate` (the token comparison and cost), `actual_usage` and
  `suggestion_ids`.

## Data model (migration `0005_prompt_intelligence.sql`)

Existing tables are reused and extended; no new column stores prompt text.

- **`prompt_analyses`**:
  - category, secondary category, confidence and classification method;
  - `dimension_scores`, `missing_information` and `rubric_version`;
  - `requirement_checklist` (IDs, kinds and character offsets into the analysed
    version, not copies);
  - `model_used`.
  An analysis is always tied to the exact version it analysed. The API reports
  `is_current: false` once the prompt has a newer version.
- **`prompt_suggestions`**: `expected_benefit`, signed `token_impact`, `source`
  (`rules`/`model`), `recommendation_score` and the `ranking` breakdown. Legacy
  categories are remapped (for example `verbosity` → `token_efficiency`).
- **`optimisation_runs`**:
  - mode (`detailed` is now allowed), `intent_category` and `token_budget`;
  - `preservation_status` and `preservation_report` (statuses and offsets only);
  - `iterations` and `engine`.
  Token counts, reduction, cost before and after, and the pricing version use
  the existing columns.
- **`api_usage_records.operation_id`**: groups provider attempts of operations
  that have no stored analysis or run (unsaved analyses, semantic validation).
- **`user_prompt_preferences`**: `prompt_style`, `task_categories`,
  `helpful_suggestion_categories`, and `detailed` as a default mode.
- **`prompt_feedback_events`** (new): explicit interactions with category, task
  and mode only, under row-level security. The table is seeded from earlier
  suggestion decisions, included in the account export, and deleted with the
  account.

## Quotas and usage

- **Analyses** use the existing analysis quota (free 30, pro 1,000 per period).
- **Generations and model-based optimisations** use the optimisation quota.
- **Local-only token-saver revisions** consume no quota (nothing is billed).
- **Usage records:** every provider attempt is recorded once in
  `api_usage_records`, linked to its analysis, run or operation ID. Retried and
  repaired attempts are each recorded.
- **Global spend cap:** applies to all of these.

## Privacy

Saved prompts are used only to provide features to their owner. Personalisation
is based on explicit feedback and preferences the user controls. No shared model
is trained on users' prompts, and there is no background inference. Unsaved
text is not stored. Feedback events contain no prompt text and can be cleared
from Preferences ("Forget dismissed suggestions").

## Testing and evaluation

- **Unit tests** (`tests/unit/intelligence.test.ts`, 37), covering:
  - classification accuracy on the dataset (at least 90% required);
  - the score formula and weight normalisation, and examples not counting
    where they don't apply;
  - template selection;
  - extraction of the intermediate representation;
  - missing information;
  - preservation: preserved, missing, changed value, reversed restriction, new
    assumptions, contradictions, semantic-pass limits;
  - token percentages, negative savings, empty originals;
  - budget handling, and no model call for a sufficient local token saver;
  - the repair loop and refusals;
  - ranking smoothing and personalisation;
  - injection handling;
  - structured-output validation;
  - adapter retry and repair;
  - unsupported models.
- **Database tests** (`tests/db/intelligence.test.ts`, 13, PGlite with the real
  migrations), covering:
  - unsaved analysis not stored, with usage and quota recorded;
  - version-linked storage, and analyses becoming historical;
  - category re-analysis;
  - ownership isolation;
  - revision persistence (run, estimates, compact report);
  - save and feedback events;
  - applying suggestions;
  - local token saver uses no quota; budgets;
  - failed runs;
  - quota;
  - missing pricing;
  - validation;
  - forgetting feedback, and deletion.
- **API route tests** (`tests/api/intelligence-routes.test.ts`, 7).
- **Component tests** (`tests/components/intelligence-workspace.test.tsx`, 4).
- **End-to-end tests** (`tests/e2e/critical-flows.spec.ts`): two new flows,
  each run on desktop and mobile.
- **Regression:** the rest of the suite is unchanged in intent.
- **Evaluation:** `npm run eval:intelligence` runs
  `eval/intelligence/dataset.json` (24 cases with expected categories,
  must-preserve requirements, expected missing information and output checks).
  It reports classification accuracy, missing-information recall, requirement
  coverage, preservation verdicts, and tokens and estimated input cost per mode.
  With `OPTIMISER_PROVIDER=openai npm run eval:intelligence -- --live`, it also
  runs the original and the improved prompt as tasks on the target model and
  applies the same output checks to both, giving task success and format
  compliance. Prompt length and the heuristic score are never used alone as a
  quality measure.

### Local evaluation results

These were run with the deterministic local provider, 24 cases:

| Measure | Result |
| --- | --- |
| Classification accuracy | 24/24 |
| Missing-information recall | 100% |
| Requirement coverage, all three modes | 100% |
| Preservation failures | 0 |
| Token saver | −3% tokens overall (most dataset prompts are already concise) |
| Balanced | +66% |
| Detailed | +385% (structure and placeholders) |

The dataset was used while tuning the rules, so these are in-sample figures. The
live task-success comparison needs an OpenAI key and has not been run here.

## Limitations

- **Heuristics:** the classifier and scorer are keyword-based. The model is
  consulted only for ambiguous or longer prompts, and the rubric is a heuristic,
  not a validated measure.
- **Preservation checks:** they compare terms, values and negations. They catch
  most dropped or reversed requirements but can miss subtle changes of meaning,
  and can flag faithful paraphrases as "changed" (the semantic check, OpenAI
  only, reduces this).
- **Local provider:** it renders templates deterministically and cannot paraphrase
  or reason. The quality of detailed and balanced output depends on the real
  model.
- **In-process caching and rate limits:** the unsaved-analysis cache and the
  rate limits live in each server process, as elsewhere in the app.
- **Feedback learning:** it is per user and per suggestion kind; there is no
  cross-user learning by design.
