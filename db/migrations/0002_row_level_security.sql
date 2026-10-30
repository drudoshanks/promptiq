-- Row-level security as defence in depth (SRS NFR-002, §12 Authorisation).
--
-- The application already scopes every query by the authenticated user ID; these
-- policies make the database refuse cross-account reads/writes even if a bug slips
-- through. They take effect for non-superuser, non-owner roles when the application
-- sets a per-transaction setting (see src/lib/db/scope.ts):
--
--   SET LOCAL app.user_id = '<app_users.id>';   -- user-scoped request
--   SET LOCAL app.role    = 'system';            -- auth bootstrap, billing webhooks,
--                                                -- admin aggregates, deletion jobs
--
-- Production: create a dedicated runtime role (e.g. promptiq_app) that owns no
-- tables, grant it DML on the tables below, and connect with it. Migrations run as
-- the table owner and are unaffected. Requests with neither setting see no rows.

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_is_system() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.role', true), '') = 'system'
$$;

ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_users_owner ON app_users
  USING (id = app_current_user_id() OR app_is_system())
  WITH CHECK (id = app_current_user_id() OR app_is_system());

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_preferences_owner ON user_preferences
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

ALTER TABLE prompts ENABLE ROW LEVEL SECURITY;
CREATE POLICY prompts_owner ON prompts
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

ALTER TABLE prompt_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY prompt_versions_owner ON prompt_versions
  USING (app_is_system() OR EXISTS (
    SELECT 1 FROM prompts p WHERE p.id = prompt_id AND p.user_id = app_current_user_id()))
  WITH CHECK (app_is_system() OR EXISTS (
    SELECT 1 FROM prompts p WHERE p.id = prompt_id AND p.user_id = app_current_user_id()));

ALTER TABLE optimisation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY optimisation_runs_owner ON optimisation_runs
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY feedback_owner ON feedback
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_events_owner ON usage_events
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_owner ON subscriptions
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());
