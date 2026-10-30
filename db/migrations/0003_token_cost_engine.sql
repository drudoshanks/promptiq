-- Token & Cost Estimation Engine.
--
-- 1. model_pricing: versioned, dated pricing snapshots (no prices in application
--    code). Overlapping records for the same provider/model are rejected by a
--    trigger; at most one open-ended (current) record per model.
-- 2. token_estimates: estimates PromptIQ produced for a piece of text against a
--    target model. Never contains the text itself.
-- 3. api_usage_records: actual usage reported by the provider for each attempt
--    PromptIQ made on the user's behalf (one logical optimisation may need a
--    repair attempt). Separate from estimates by design.

-- ---------------------------------------------------------------------------
-- Pricing snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE model_pricing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  pricing_version TEXT NOT NULL UNIQUE,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  input_per_million NUMERIC(12,6) NOT NULL CHECK (input_per_million >= 0),
  cached_input_per_million NUMERIC(12,6) CHECK (cached_input_per_million IS NULL OR cached_input_per_million >= 0),
  output_per_million NUMERIC(12,6) NOT NULL CHECK (output_per_million >= 0),
  -- Additional categories a model may bill (e.g. batch rates), per million tokens.
  extra_prices JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  source TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX idx_model_pricing_current
  ON model_pricing(provider, model_id) WHERE effective_to IS NULL;
CREATE INDEX idx_model_pricing_lookup
  ON model_pricing(provider, model_id, effective_from DESC);

CREATE OR REPLACE FUNCTION model_pricing_reject_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM model_pricing p
    WHERE p.provider = NEW.provider
      AND p.model_id = NEW.model_id
      AND p.id <> NEW.id
      AND tstzrange(p.effective_from, p.effective_to, '[)')
          && tstzrange(NEW.effective_from, NEW.effective_to, '[)')
  ) THEN
    RAISE EXCEPTION 'model_pricing: overlapping pricing period for % / %', NEW.provider, NEW.model_id
      USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_model_pricing_no_overlap
  BEFORE INSERT OR UPDATE ON model_pricing
  FOR EACH ROW EXECUTE FUNCTION model_pricing_reject_overlap();

-- ---------------------------------------------------------------------------
-- Estimates (what PromptIQ computed) — never the text itself.
-- Costs use 10 decimal places: a short prompt on a small model costs well under
-- a millionth of a dollar, which 6 places would round to zero.
-- ---------------------------------------------------------------------------
CREATE TABLE token_estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  prompt_version_id UUID REFERENCES prompt_versions(id) ON DELETE SET NULL,
  run_id UUID REFERENCES optimisation_runs(id) ON DELETE SET NULL,
  -- original | optimised | final (counted before export) | adhoc
  label TEXT NOT NULL CHECK (label IN ('original','optimised','final','adhoc')),
  model_id TEXT NOT NULL,
  encoding TEXT NOT NULL,
  tokenizer_version TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  character_count INTEGER NOT NULL CHECK (character_count >= 0),
  expected_output_tokens INTEGER NOT NULL CHECK (expected_output_tokens >= 0),
  estimated_input_cost NUMERIC(16,10),
  estimated_output_cost NUMERIC(16,10),
  estimated_total_cost NUMERIC(16,10),
  pricing_version TEXT REFERENCES model_pricing(pricing_version) ON DELETE SET NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_token_estimates_user_created ON token_estimates(user_id, created_at DESC);
CREATE INDEX idx_token_estimates_version ON token_estimates(prompt_version_id);
CREATE INDEX idx_token_estimates_run ON token_estimates(run_id);

-- ---------------------------------------------------------------------------
-- Actual usage (what the provider reported) — one row per provider attempt
-- ---------------------------------------------------------------------------
CREATE TABLE api_usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  run_id UUID REFERENCES optimisation_runs(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  request_type TEXT NOT NULL,
  provider_request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','refused','incomplete','invalid_output','error')),
  -- FALSE when the provider returned no usage (timeout, connection error): the
  -- token columns are then 0 and actual_cost is NULL, never a guess.
  usage_reported BOOLEAN NOT NULL DEFAULT TRUE,
  actual_input_tokens INTEGER NOT NULL CHECK (actual_input_tokens >= 0),
  actual_output_tokens INTEGER NOT NULL CHECK (actual_output_tokens >= 0),
  actual_total_tokens INTEGER NOT NULL CHECK (actual_total_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  actual_cost NUMERIC(16,10),
  pricing_version TEXT REFERENCES model_pricing(pricing_version) ON DELETE SET NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, attempt)
);
CREATE INDEX idx_api_usage_user_created ON api_usage_records(user_id, created_at DESC);
CREATE INDEX idx_api_usage_model_created ON api_usage_records(model_id, created_at DESC);

ALTER TABLE optimisation_runs
  ADD COLUMN pricing_version TEXT,
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0);

-- Row-level security, same pattern as 0002.
ALTER TABLE token_estimates ENABLE ROW LEVEL SECURITY;
CREATE POLICY token_estimates_owner ON token_estimates
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

ALTER TABLE api_usage_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_usage_records_owner ON api_usage_records
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

-- ---------------------------------------------------------------------------
-- Seed pricing snapshots (USD per 1M tokens, standard tier).
-- Only rates checked against OpenAI's own model pages on 2026-10-30 are seeded.
-- Every other supported model is countable but shows "pricing missing" until an
-- operator records a verified rate with `npm run pricing:add` (see
-- docs/token-cost-estimation.md). The application flags records whose
-- verified_at is older than PRICING_STALE_AFTER_DAYS as possibly out of date.
-- ---------------------------------------------------------------------------
INSERT INTO model_pricing
  (provider, model_id, pricing_version, input_per_million, cached_input_per_million, output_per_million, effective_from, source, verified_at, notes)
VALUES
  ('openai', 'gpt-5-mini', 'openai:gpt-5-mini:2026-10-30', 0.25, 0.025, 2.00,  '2025-08-07T00:00:00Z', 'https://developers.openai.com/api/docs/models/gpt-5-mini', '2026-10-30T00:00:00Z', 'Standard tier, from the OpenAI model page.'),
  ('openai', 'gpt-5-nano', 'openai:gpt-5-nano:2026-10-30', 0.05, 0.005, 0.40,  '2025-08-07T00:00:00Z', 'https://developers.openai.com/api/docs/models/gpt-5-nano', '2026-10-30T00:00:00Z', 'Standard tier, from the OpenAI model page.'),
  ('openai', 'gpt-4o',     'openai:gpt-4o:2026-10-30',     2.50, 1.25,  10.00, '2024-08-06T00:00:00Z', 'https://developers.openai.com/api/docs/models/gpt-4o',     '2026-10-30T00:00:00Z', 'Standard tier, from the OpenAI model page.'),
  ('mock',   'mock-optimiser', 'mock:mock-optimiser:2026-10-30', 0.00, 0.00, 0.00, '2026-01-01T00:00:00Z', 'internal mock provider (no cost)', '2026-10-30T00:00:00Z', 'Deterministic local optimiser used in development and tests.');
