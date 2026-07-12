-- Multi-tenancy infrastructure for white-label install system

-- Tenants (root entity for multi-tenancy)
CREATE TABLE IF NOT EXISTS boss_tenants (
  id text PRIMARY KEY, -- UUID or email hash
  name text NOT NULL, -- User's full name
  business_name text, -- Business/company name
  primary_email text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active', -- active, trial, suspended, cancelled
  openrouter_api_key text, -- Encrypted at rest via BOSS_TOKEN_ENCRYPTION_KEY
  plan text DEFAULT 'free', -- free, pro, enterprise
  onboarding_completed boolean DEFAULT false,
  onboarding_step text DEFAULT 'welcome', -- welcome, connectors, agents, preferences, complete
  metadata jsonb DEFAULT '{}', -- Flexible storage for custom fields
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CHECK (status IN ('active', 'trial', 'suspended', 'cancelled')),
  CHECK (plan IN ('free', 'pro', 'enterprise', 'custom')),
  CHECK (onboarding_step IN ('welcome', 'connectors', 'agents', 'preferences', 'complete'))
);

CREATE INDEX idx_tenants_email ON boss_tenants(primary_email);
CREATE INDEX idx_tenants_status ON boss_tenants(status) WHERE status IN ('active', 'trial');

-- Users (per-tenant users, starting with primary admin)
CREATE TABLE IF NOT EXISTS boss_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES boss_tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_hash text NOT NULL, -- bcrypt
  display_name text NOT NULL, -- What AIOS calls them: "Kevin", "Boss", etc.
  role text NOT NULL DEFAULT 'admin', -- admin, user, agent
  active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  preferences jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(tenant_id, email),
  CHECK (role IN ('admin', 'user', 'agent'))
);

CREATE INDEX idx_users_tenant ON boss_users(tenant_id, email);
CREATE INDEX idx_users_active ON boss_users(tenant_id, active) WHERE active = true;

-- Onboarding progress tracking
CREATE TABLE IF NOT EXISTS boss_onboarding (
  tenant_id text PRIMARY KEY REFERENCES boss_tenants(id) ON DELETE CASCADE,
  step text NOT NULL DEFAULT 'welcome',
  completed_steps jsonb DEFAULT '[]', -- Array of step names completed
  skipped_steps jsonb DEFAULT '[]', -- Array of step names skipped
  connector_progress jsonb DEFAULT '{}', -- Which connectors configured
  agent_progress jsonb DEFAULT '{}', -- Which agents enabled
  data jsonb DEFAULT '{}', -- Store form data between steps
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),

  CHECK (step IN ('welcome', 'connectors', 'agents', 'preferences', 'complete'))
);

CREATE INDEX idx_onboarding_incomplete ON boss_onboarding(tenant_id, last_activity_at)
  WHERE completed_at IS NULL;

-- Subscriptions (optional, for billing)
CREATE TABLE IF NOT EXISTS boss_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL UNIQUE REFERENCES boss_tenants(id) ON DELETE CASCADE,
  plan text NOT NULL, -- free, pro, enterprise
  stripe_customer_id text,
  stripe_subscription_id text,
  status text NOT NULL DEFAULT 'active', -- active, trialing, past_due, cancelled, unpaid
  trial_end_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CHECK (status IN ('active', 'trialing', 'past_due', 'cancelled', 'unpaid'))
);

CREATE INDEX idx_subscriptions_tenant ON boss_subscriptions(tenant_id);
CREATE INDEX idx_subscriptions_stripe_customer ON boss_subscriptions(stripe_customer_id);

-- Usage tracking (for billing and limits)
CREATE TABLE IF NOT EXISTS boss_tenant_usage (
  tenant_id text NOT NULL REFERENCES boss_tenants(id) ON DELETE CASCADE,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  tokens_used bigint DEFAULT 0,
  api_calls bigint DEFAULT 0,
  storage_bytes bigint DEFAULT 0,
  agents_active integer DEFAULT 0,
  data jsonb DEFAULT '{}', -- Detailed breakdown by agent, model, etc.
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, period_start)
);

CREATE INDEX idx_tenant_usage_period ON boss_tenant_usage(tenant_id, period_start DESC);

-- Migration: Create default tenant for existing data
INSERT INTO boss_tenants (id, name, business_name, primary_email, status, plan, onboarding_completed)
VALUES ('default', 'D. Caine Solutions', 'D. Caine Solutions', 'd.caine@dcaine.com', 'active', 'enterprise', true)
ON CONFLICT (id) DO NOTHING;

-- Migration: Create default user (password hash is placeholder - user should reset)
-- Password: "changeme123" (bcrypt hash with 12 rounds)
INSERT INTO boss_users (tenant_id, email, password_hash, display_name, role, active)
VALUES ('default', 'd.caine@dcaine.com', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5eoKvW8qfBq3i', 'Kevin', 'admin', true)
ON CONFLICT (tenant_id, email) DO NOTHING;

-- Migration: Mark onboarding complete for default tenant
INSERT INTO boss_onboarding (tenant_id, step, completed_steps, completed_at)
VALUES ('default', 'complete', '["welcome","connectors","agents","preferences"]', NOW())
ON CONFLICT (tenant_id) DO NOTHING;

COMMENT ON TABLE boss_tenants IS 'Root entity for multi-tenancy - each install creates a tenant';
COMMENT ON TABLE boss_users IS 'Per-tenant users with authentication credentials';
COMMENT ON TABLE boss_onboarding IS 'Onboarding wizard progress tracking per tenant';
COMMENT ON TABLE boss_subscriptions IS 'Billing and subscription management (Stripe integration)';
COMMENT ON TABLE boss_tenant_usage IS 'Token/API usage tracking for billing and rate limiting';
