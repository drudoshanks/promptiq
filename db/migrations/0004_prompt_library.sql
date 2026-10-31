-- Personal Prompt Library, Smart Suggestions & Token Optimisation.
--
-- Builds on existing tables instead of duplicating them:
--   * prompts / prompt_versions stay the source of truth for text. Versions are
--     immutable; the "original" text is version 1 and the "current" text is the
--     version pointed to by current_version_id (always the newest version), so
--     prompt text is never stored twice.
--   * app_users.history_enabled is the auto-save setting.
--   * optimisation_runs records library optimisations (mode, target, savings).
-- The denormalised columns on prompts (token counts, scores, counters) are
-- recomputed from source tables by refreshPromptStats() after every write that
-- affects them, so listings can filter and sort with indexes.

-- ---------------------------------------------------------------------------
-- prompts: library metadata
-- ---------------------------------------------------------------------------
ALTER TABLE prompts
  ADD COLUMN description TEXT CHECK (description IS NULL OR length(description) <= 1000),
  ADD COLUMN target_model TEXT,
  ADD COLUMN current_version_id UUID REFERENCES prompt_versions(id) ON DELETE SET NULL,
  ADD COLUMN is_favourite BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN last_used_at TIMESTAMPTZ,
  ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  ADD COLUMN current_version_number INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN original_token_count INTEGER,
  ADD COLUMN current_token_count INTEGER,
  ADD COLUMN optimisation_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN latest_optimisation_status TEXT,
  ADD COLUMN latest_quality_score SMALLINT CHECK (latest_quality_score IS NULL OR latest_quality_score BETWEEN 0 AND 100),
  ADD COLUMN latest_analysis_at TIMESTAMPTZ,
  ADD COLUMN pending_suggestion_count INTEGER NOT NULL DEFAULT 0,
  -- 3 = high, 2 = medium, 1 = low, 0 = none: highest priority among pending suggestions.
  ADD COLUMN pending_priority SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN latest_estimated_cost NUMERIC(16,10),
  ADD COLUMN latest_pricing_version TEXT;

CREATE INDEX idx_prompts_user_favourite ON prompts(user_id, is_favourite, updated_at DESC);
CREATE INDEX idx_prompts_user_category ON prompts(user_id, category);
CREATE INDEX idx_prompts_user_last_used ON prompts(user_id, last_used_at DESC NULLS LAST);
CREATE INDEX idx_prompts_user_attention ON prompts(user_id, pending_priority DESC, latest_quality_score);

-- ---------------------------------------------------------------------------
-- prompt_versions: provenance for library actions, tokenizer, author
-- ---------------------------------------------------------------------------
ALTER TABLE prompt_versions DROP CONSTRAINT prompt_versions_provenance_check;
ALTER TABLE prompt_versions ADD CONSTRAINT prompt_versions_provenance_check CHECK (
  provenance IN ('original','ai_optimised','user_edited','imported','restored','duplicated','suggestion_applied')
);
ALTER TABLE prompt_versions
  ADD COLUMN tokenizer_version TEXT,
  ADD COLUMN created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN optimisation_run_id UUID REFERENCES optimisation_runs(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- optimisation_runs: library optimisation details
-- ---------------------------------------------------------------------------
ALTER TABLE optimisation_runs
  ADD COLUMN optimisation_mode TEXT NOT NULL DEFAULT 'balanced'
    CHECK (optimisation_mode IN ('balanced','token_saver','quality_first','custom')),
  ADD COLUMN target_model TEXT,
  ADD COLUMN tokens_saved INTEGER,
  ADD COLUMN reduction_percent NUMERIC(7,2),
  ADD COLUMN estimated_input_cost_before NUMERIC(16,10),
  ADD COLUMN estimated_input_cost_after NUMERIC(16,10),
  ADD COLUMN applied_suggestion_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_runs_prompt_created ON optimisation_runs(prompt_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Analyses and suggestions
-- ---------------------------------------------------------------------------
CREATE TABLE prompt_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  prompt_id UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  prompt_version_id UUID NOT NULL REFERENCES prompt_versions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  quality_score SMALLINT CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 100),
  already_optimised BOOLEAN NOT NULL DEFAULT FALSE,
  -- Validated structured output (summary, recommended actions, questions). The
  -- prompt text itself is not copied here.
  analysis_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_model TEXT,
  model_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  actual_cost NUMERIC(16,10),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX idx_analyses_prompt_created ON prompt_analyses(prompt_id, created_at DESC);
CREATE INDEX idx_analyses_user_created ON prompt_analyses(user_id, created_at DESC);
-- At most one completed and one in-flight analysis per version: re-analysis of
-- an unchanged version reuses the stored result unless explicitly forced.
CREATE UNIQUE INDEX idx_analyses_one_running ON prompt_analyses(prompt_version_id) WHERE status = 'running';

CREATE TABLE prompt_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  analysis_id UUID NOT NULL REFERENCES prompt_analyses(id) ON DELETE CASCADE,
  prompt_id UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  prompt_version_id UUID NOT NULL REFERENCES prompt_versions(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('high','medium','low')),
  title TEXT NOT NULL,
  explanation TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  estimated_token_impact TEXT CHECK (estimated_token_impact IS NULL OR estimated_token_impact IN ('none','low','medium','high')),
  token_direction TEXT CHECK (token_direction IS NULL OR token_direction IN ('reduce','increase','neutral')),
  requires_user_context BOOLEAN NOT NULL DEFAULT FALSE,
  context_question TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed','deferred','applied')),
  applied_version_id UUID REFERENCES prompt_versions(id) ON DELETE SET NULL,
  feedback_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (analysis_id, position)
);
CREATE INDEX idx_suggestions_prompt_status ON prompt_suggestions(prompt_id, status);
CREATE INDEX idx_suggestions_user_status ON prompt_suggestions(user_id, status, created_at DESC);

-- Analyses consume provider calls too: attribute their attempts.
ALTER TABLE api_usage_records ADD COLUMN analysis_id UUID REFERENCES prompt_analyses(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_api_usage_analysis_attempt ON api_usage_records(analysis_id, attempt) WHERE analysis_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Prompt preferences (one row per user). Auto-save is app_users.history_enabled;
-- tone/detail/format live in user_preferences. Nothing here is inferred.
-- ---------------------------------------------------------------------------
CREATE TABLE user_prompt_preferences (
  user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  preferred_model TEXT,
  preferred_style TEXT CHECK (preferred_style IS NULL OR preferred_style IN ('natural','structured','bullet_points','step_by_step')),
  preferred_response_length TEXT CHECK (preferred_response_length IS NULL OR preferred_response_length IN ('short','medium','long')),
  token_efficiency_priority TEXT NOT NULL DEFAULT 'balanced' CHECK (token_efficiency_priority IN ('low','balanced','high')),
  default_optimisation_mode TEXT NOT NULL DEFAULT 'balanced' CHECK (default_optimisation_mode IN ('balanced','token_saver','quality_first')),
  -- Use-case areas the user typed in themselves (e.g. "marketing emails").
  domains TEXT[] NOT NULL DEFAULT '{}',
  -- Use accepted/dismissed suggestion history to tailor analyses.
  learn_from_feedback BOOLEAN NOT NULL DEFAULT TRUE,
  -- Background analysis of newly saved prompts (off by default: costs quota).
  background_analysis BOOLEAN NOT NULL DEFAULT FALSE,
  preferences_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill denormalised columns for existing prompts.
UPDATE prompts p SET
  current_version_id = v.id,
  current_version_number = v.version_number,
  current_token_count = v.token_estimate
FROM (
  SELECT DISTINCT ON (prompt_id) id, prompt_id, version_number, token_estimate
  FROM prompt_versions ORDER BY prompt_id, version_number DESC
) v
WHERE v.prompt_id = p.id;
UPDATE prompts p SET original_token_count = v.token_estimate
FROM prompt_versions v WHERE v.prompt_id = p.id AND v.version_number = 1;

-- Row-level security, same pattern as 0002/0003.
ALTER TABLE prompt_analyses ENABLE ROW LEVEL SECURITY;
CREATE POLICY prompt_analyses_owner ON prompt_analyses
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());
ALTER TABLE prompt_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY prompt_suggestions_owner ON prompt_suggestions
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());
ALTER TABLE user_prompt_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_prompt_preferences_owner ON user_prompt_preferences
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());
