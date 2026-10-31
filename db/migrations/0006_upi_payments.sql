-- UPI payments with manual verification. Money is integer paise. PromptIQ never
-- sees UPI PINs, OTPs or bank credentials; it records payment requests, the
-- user's unverified claim, and an administrator's independent verification.
-- Entitlements stay where they were: app_users.plan_code + subscriptions.

-- ---------------------------------------------------------------------------
-- Plan catalogue (server-side prices; clients never supply amounts)
-- ---------------------------------------------------------------------------
CREATE TABLE billing_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]{2,40}$'),
  entitlement TEXT NOT NULL CHECK (entitlement IN ('pro')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 10000000),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  billing_period TEXT NOT NULL CHECK (billing_period IN ('month','year')),
  period_months SMALLINT NOT NULL CHECK (period_months BETWEEN 1 AND 36),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Launch prices. Change them with an UPDATE (see docs/upi-payments.md); open
-- payment requests keep the amount they were created with.
INSERT INTO billing_plans (code, entitlement, name, description, amount_minor, billing_period, period_months, sort_order) VALUES
  ('pro_monthly', 'pro', 'Pro — monthly', 'All Pro limits for one month. Pay again to renew; nothing is charged automatically.', 49900, 'month', 1, 1),
  ('pro_yearly', 'pro', 'Pro — yearly', 'All Pro limits for twelve months, for the price of ten.', 499000, 'year', 12, 2);

-- ---------------------------------------------------------------------------
-- Payment requests and their state machine
-- ---------------------------------------------------------------------------
CREATE TABLE payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES billing_plans(id),
  payment_reference TEXT NOT NULL UNIQUE CHECK (payment_reference ~ '^PIQ-[0-9]{4}-[0-9A-Z]{5}$'),
  -- Snapshot of the price and payee at creation: later price changes never alter an open request.
  expected_amount_minor INTEGER NOT NULL CHECK (expected_amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  payee_vpa TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (status IN (
    'PENDING_PAYMENT','SUBMITTED_FOR_VERIFICATION','UNDER_REVIEW','VERIFIED','REJECTED','CANCELLED','EXPIRED'
  )),
  -- Latest claimed UPI transaction reference (normalised). Unique across all
  -- requests, including rejected ones, so a reference can never be reused.
  transaction_reference_normalized TEXT,
  amount_mismatch BOOLEAN NOT NULL DEFAULT FALSE,
  info_requested BOOLEAN NOT NULL DEFAULT FALSE,
  info_request_message TEXT,
  rejection_reason TEXT,
  assigned_admin_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  verified_amount_minor INTEGER CHECK (verified_amount_minor IS NULL OR verified_amount_minor > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'VERIFIED' OR (verified_at IS NOT NULL AND verified_amount_minor IS NOT NULL AND transaction_reference_normalized IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR (rejected_at IS NOT NULL AND rejection_reason IS NOT NULL))
);
CREATE UNIQUE INDEX idx_payment_requests_txn_ref ON payment_requests(transaction_reference_normalized) WHERE transaction_reference_normalized IS NOT NULL;
CREATE INDEX idx_payment_requests_user_created ON payment_requests(user_id, created_at DESC);
CREATE INDEX idx_payment_requests_status_created ON payment_requests(status, created_at DESC);
-- At most one open request per user (pending, submitted or under review).
CREATE UNIQUE INDEX idx_payment_requests_one_open ON payment_requests(user_id)
  WHERE status IN ('PENDING_PAYMENT','SUBMITTED_FOR_VERIFICATION','UNDER_REVIEW');

-- Private screenshot storage (never in a public directory). Retention is
-- enforced by the maintenance job.
CREATE TABLE payment_screenshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id UUID NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 2097152),
  sha256 TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_screenshots_request ON payment_screenshots(payment_request_id);

-- Every claim the user makes (resubmissions after an information request add rows).
CREATE TABLE payment_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id UUID NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  transaction_reference TEXT NOT NULL CHECK (length(transaction_reference) BETWEEN 6 AND 40),
  transaction_reference_normalized TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  amount_mismatch BOOLEAN NOT NULL DEFAULT FALSE,
  paid_at TIMESTAMPTZ NOT NULL,
  screenshot_id UUID REFERENCES payment_screenshots(id) ON DELETE SET NULL,
  user_notes TEXT CHECK (user_notes IS NULL OR length(user_notes) <= 1000),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_submissions_request ON payment_submissions(payment_request_id, submitted_at DESC);

-- Administrator actions: immutable audit trail.
CREATE TABLE payment_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id UUID NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  admin_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('marked_under_review','verified','rejected','information_requested','recovered')),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT,
  verification_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_reviews_request ON payment_reviews(payment_request_id, created_at);

-- Subscription audit events. One activation per payment request, enforced here.
CREATE TABLE subscription_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  payment_request_id UUID REFERENCES payment_requests(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('activated','renewed','expired','expiry_reminder_sent')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_subscription_events_one_activation ON subscription_events(payment_request_id)
  WHERE event_type IN ('activated','renewed');
CREATE INDEX idx_subscription_events_user ON subscription_events(user_id, created_at DESC);

-- Audit tables are append-only.
CREATE FUNCTION forbid_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER payment_reviews_append_only BEFORE UPDATE OR DELETE ON payment_reviews
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER subscription_events_append_only BEFORE UPDATE OR DELETE ON subscription_events
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION forbid_audit_mutation();

-- ---------------------------------------------------------------------------
-- Notification outbox: written in the same transaction as the state change,
-- delivered only after commit, retried with backoff.
-- ---------------------------------------------------------------------------
CREATE TABLE notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES app_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts SMALLINT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notification_outbox_due ON notification_outbox(next_attempt_at) WHERE status = 'pending';

-- Row-level security, same pattern as earlier migrations.
ALTER TABLE payment_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_requests_owner ON payment_requests
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());
ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscription_events_owner ON subscription_events
  USING (user_id = app_current_user_id() OR app_is_system())
  WITH CHECK (user_id = app_current_user_id() OR app_is_system());
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_outbox_system ON notification_outbox
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE payment_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_submissions_owner ON payment_submissions
  USING (app_is_system() OR EXISTS (SELECT 1 FROM payment_requests r WHERE r.id = payment_request_id AND r.user_id = app_current_user_id()))
  WITH CHECK (app_is_system() OR EXISTS (SELECT 1 FROM payment_requests r WHERE r.id = payment_request_id AND r.user_id = app_current_user_id()));
ALTER TABLE payment_screenshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_screenshots_system ON payment_screenshots
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE payment_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_reviews_owner ON payment_reviews
  USING (app_is_system() OR EXISTS (SELECT 1 FROM payment_requests r WHERE r.id = payment_request_id AND r.user_id = app_current_user_id()))
  WITH CHECK (app_is_system());
