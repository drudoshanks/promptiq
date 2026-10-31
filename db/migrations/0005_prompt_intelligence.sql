-- Prompt Intelligence Engine (classification, rubric scoring, requirement
-- preservation, feedback ranking). Extends the prompt-library tables rather
-- than duplicating them. No new column stores prompt text: requirement
-- checklists keep character offsets into the analysed version instead.

-- ---------------------------------------------------------------------------
-- prompt_analyses: structured intent and rubric scores per analysed version
-- ---------------------------------------------------------------------------
ALTER TABLE prompt_analyses
  ADD COLUMN task_category TEXT,
  ADD COLUMN secondary_category TEXT,
  ADD COLUMN classification_confidence NUMERIC(4,3) CHECK (classification_confidence IS NULL OR classification_confidence BETWEEN 0 AND 1),
  ADD COLUMN classification_method TEXT CHECK (classification_method IS NULL OR classification_method IN ('rules','model','user')),
  ADD COLUMN dimension_scores JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN missing_information JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN requirement_checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN rubric_version TEXT,
  ADD COLUMN model_used BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX idx_analyses_version_created ON prompt_analyses(prompt_version_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- prompt_suggestions: full suggestion contract and ranking transparency
-- ---------------------------------------------------------------------------
ALTER TABLE prompt_suggestions
  ADD COLUMN expected_benefit TEXT,
  ADD COLUMN token_impact INTEGER,
  ADD COLUMN source TEXT NOT NULL DEFAULT 'model' CHECK (source IN ('rules','model')),
  ADD COLUMN recommendation_score NUMERIC(5,3),
  ADD COLUMN ranking JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Map the first release's categories onto the current set.
UPDATE prompt_suggestions SET category = CASE category
  WHEN 'ambiguity' THEN 'clarity'
  WHEN 'repetition' THEN 'redundancy'
  WHEN 'verbosity' THEN 'token_efficiency'
  WHEN 'conflicting_constraints' THEN 'contradictions'
  WHEN 'role_audience' THEN 'missing_context'
  WHEN 'model_suitability' THEN 'task_specific'
  ELSE category END;

-- ---------------------------------------------------------------------------
-- optimisation_runs: generation mode, budget and preservation outcome
-- ---------------------------------------------------------------------------
ALTER TABLE optimisation_runs DROP CONSTRAINT IF EXISTS optimisation_runs_optimisation_mode_check;
ALTER TABLE optimisation_runs ADD CONSTRAINT optimisation_runs_optimisation_mode_check
  CHECK (optimisation_mode IN ('detailed','balanced','token_saver','quality_first','custom'));
ALTER TABLE optimisation_runs
  ADD COLUMN intent_category TEXT,
  ADD COLUMN token_budget INTEGER CHECK (token_budget IS NULL OR token_budget > 0),
  ADD COLUMN preservation_status TEXT CHECK (preservation_status IS NULL OR preservation_status IN ('passed','needs_review','failed')),
  ADD COLUMN preservation_report JSONB,
  ADD COLUMN iterations SMALLINT,
  ADD COLUMN engine TEXT CHECK (engine IS NULL OR engine IN ('local','model'));

-- ---------------------------------------------------------------------------
-- api_usage_records: provider calls of unsaved analyses and validation checks
-- belong to no stored analysis or run; operation_id groups their attempts.
-- ---------------------------------------------------------------------------
ALTER TABLE api_usage_records ADD COLUMN operation_id UUID;
CREATE UNIQUE INDEX idx_api_usage_operation_attempt ON api_usage_records(operation_id, attempt) WHERE operation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- user_prompt_preferences: explicit, user-controlled personalisation
-- ---------------------------------------------------------------------------
ALTER TABLE user_prompt_preferences DROP CONSTRAINT IF EXISTS user_prompt_preferences_default_optimisation_mode_check;
ALTER TABLE user_prompt_preferences ADD CONSTRAINT user_prompt_preferences_default_optimisation_mode_check
  CHECK (default_optimisation_mode IN ('detailed','balanced','token_saver','quality_first'));
ALTER TABLE user_prompt_preferences
  ADD COLUMN prompt_style TEXT CHECK (prompt_style IS NULL OR prompt_style IN ('minimal','balanced','comprehensive')),
  ADD COLUMN task_categories TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN helpful_suggestion_categories TEXT[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- prompt_feedback_events: explicit interactions that drive ranking.
-- Categories and modes only, never prompt text.
-- ---------------------------------------------------------------------------
CREATE TABLE prompt_feedback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  prompt_id UUID REFERENCES prompts(id) ON DELETE SET NULL,
  prompt_version_id UUID REFERENCES prompt_versions(id) ON DELETE SET NULL,
  suggestion_id UUID REFERENCES prompt_suggestions(id) ON DELETE SET NULL,
  run_id UUID REFERENCES optimisation_runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'suggestion_accepted','suggestion_dismissed','suggestion_deferred',
    'mode_selected','revision_saved','version_restored','rated_helpful','rated_unhelpful'
  )),
  suggestion_category TEXT,
  task_category TEXT,
  optimisation_mode TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_feedback_events_user_created ON prompt_feedback_events(user_id, created_at DESC);
CREATE INDEX idx_feedback_events_user_category ON prompt_feedback_events(user_id, suggestion_category, task_category);

-- Seed ranking history from suggestion decisions made before this release.
INSERT INTO prompt_feedback_events (user_id, prompt_id, prompt_version_id, suggestion_id, event_type, suggestion_category, created_at)
SELECT user_id, prompt_id, prompt_version_id, id,
  CASE WHEN status IN ('accepted','applied') THEN 'suggestion_accepted' ELSE 'suggestion_dismissed' END,
  category, coalesce(feedback_at, created_at)
FROM prompt_suggestions
WHERE status IN ('accepted','applied','dismissed');

ALTER TABLE prompt_feedback_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY prompt_feedback_events_owner ON prompt_feedback_events
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());
