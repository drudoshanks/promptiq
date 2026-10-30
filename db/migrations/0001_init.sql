-- PromptIQ baseline schema (SRS §9.2) — PostgreSQL 14+.
-- gen_random_uuid() is built into PostgreSQL 13+, so no pgcrypto extension is required.
-- Email is stored as a normalised (lower-cased, trimmed) TEXT column instead of CITEXT
-- so the schema has no extension dependencies (SRS §9.2 implementation note).

-- ---------------------------------------------------------------------------
-- Authentication tables (Better Auth). These hold credentials and sessions only;
-- application data lives in app_users and below, keyed by auth_subject.
-- ---------------------------------------------------------------------------
CREATE TABLE auth_user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_session (
  id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE
);
CREATE INDEX idx_auth_session_user ON auth_session(user_id);

CREATE TABLE auth_account (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  scope TEXT,
  password TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_account_user ON auth_account(user_id);

CREATE TABLE auth_verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_verification_identifier ON auth_verification(identifier);

-- ---------------------------------------------------------------------------
-- Application tables (SRS §9.2)
-- ---------------------------------------------------------------------------
CREATE TABLE app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  display_name TEXT,
  plan_code TEXT NOT NULL DEFAULT 'free'
    CHECK (plan_code IN ('free','pro')),
  history_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  personalisation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  onboarded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'general',
  preference_key TEXT NOT NULL,
  preference_value JSONB NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user_entered','user_confirmed','feedback')),
  confidence NUMERIC(4,3) NOT NULL DEFAULT 1.000
    CHECK (confidence >= 0 AND confidence <= 1),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, category, preference_key)
);
CREATE INDEX idx_preferences_user_enabled
  ON user_preferences(user_id, enabled, category);

CREATE TABLE prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Untitled prompt',
  category TEXT NOT NULL DEFAULT 'general',
  tags TEXT[] NOT NULL DEFAULT '{}',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_prompts_user_updated
  ON prompts(user_id, updated_at DESC);
CREATE INDEX idx_prompts_title_fts
  ON prompts USING GIN (to_tsvector('english', title));

CREATE TABLE prompt_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  parent_version_id UUID REFERENCES prompt_versions(id) ON DELETE SET NULL,
  provenance TEXT NOT NULL CHECK (
    provenance IN ('original','ai_optimised','user_edited','imported')
  ),
  prompt_text TEXT NOT NULL,
  change_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  token_estimate INTEGER,
  token_estimate_method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, version_number)
);
CREATE INDEX idx_prompt_versions_prompt_created
  ON prompt_versions(prompt_id, created_at DESC);
CREATE INDEX idx_prompt_versions_text_fts
  ON prompt_versions USING GIN (to_tsvector('english', prompt_text));

CREATE TABLE optimisation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  prompt_id UUID REFERENCES prompts(id) ON DELETE SET NULL,
  source_version_id UUID REFERENCES prompt_versions(id) ON DELETE SET NULL,
  result_version_id UUID REFERENCES prompt_versions(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'openai',
  model_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  task_category TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('queued','succeeded','failed','refused','incomplete')
  ),
  input_chars INTEGER NOT NULL CHECK (input_chars >= 0),
  output_chars INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_input_tokens INTEGER,
  estimated_cost_usd NUMERIC(12,6),
  latency_ms INTEGER,
  request_id TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_runs_user_created ON optimisation_runs(user_id, created_at DESC);
CREATE INDEX idx_runs_status_created ON optimisation_runs(status, created_at DESC);

CREATE TABLE feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES optimisation_runs(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating IN (-1, 1)),
  reason_code TEXT,
  comment TEXT,
  preference_suggestion JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, run_id)
);

CREATE TABLE usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  run_id UUID REFERENCES optimisation_runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 1 CHECK (units >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_user_created ON usage_events(user_id, created_at DESC);
CREATE INDEX idx_usage_type_created ON usage_events(event_type, created_at DESC);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE CASCADE,
  billing_provider TEXT NOT NULL,
  provider_customer_id TEXT,
  provider_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('trialing','active','past_due','canceled','incomplete','none')
  ),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_subscriptions_customer ON subscriptions(provider_customer_id);

CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ,
  processing_status TEXT NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received','processed','failed')),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE deletion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_code TEXT
);
CREATE INDEX idx_deletion_jobs_user ON deletion_jobs(user_id);
