-- Agent infrastructure: decisions, notifications, monitoring

-- Agent decision tracking (for learning from human feedback)
CREATE TABLE IF NOT EXISTS boss_agent_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'default',
  agent_handle text NOT NULL,
  decision_type text NOT NULL, -- 'draft_email', 'draft_whatsapp', 'extract_insight', 'create_task'
  context jsonb NOT NULL DEFAULT '{}', -- Input context for the decision
  draft jsonb NOT NULL DEFAULT '{}', -- What the agent drafted/proposed
  human_action text, -- 'approved', 'modified', 'rejected', 'timeout'
  human_modification jsonb, -- If modified, what changed
  confidence_score real, -- Agent's confidence in the decision (0-1)
  model_used text NOT NULL,
  tokens_used integer,
  cost_usd numeric(10, 6),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz, -- When human made decision

  CHECK (decision_type IN ('draft_email', 'draft_whatsapp', 'extract_insight', 'create_task', 'schedule_meeting')),
  CHECK (human_action IS NULL OR human_action IN ('approved', 'modified', 'rejected', 'timeout'))
);

CREATE INDEX idx_agent_decisions_agent ON boss_agent_decisions(tenant_id, agent_handle, created_at DESC);
CREATE INDEX idx_agent_decisions_pending ON boss_agent_decisions(tenant_id, created_at DESC) WHERE human_action IS NULL;

-- Push notifications for browser
CREATE TABLE IF NOT EXISTS boss_push_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'default',
  user_id text NOT NULL, -- User handle (e.g., 'kevin')
  agent_handle text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}', -- Action payload
  priority text NOT NULL DEFAULT 'normal', -- 'low', 'normal', 'high', 'urgent'
  action_required boolean NOT NULL DEFAULT false,
  action_type text, -- 'approve_draft', 'review_insight', 'confirm_send'
  related_decision_id uuid REFERENCES boss_agent_decisions(id),
  read_at timestamptz,
  acted_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
);

CREATE INDEX idx_push_notifications_user ON boss_push_notifications(tenant_id, user_id, created_at DESC);
CREATE INDEX idx_push_notifications_pending ON boss_push_notifications(tenant_id, user_id, created_at DESC)
  WHERE read_at IS NULL AND (expires_at IS NULL OR expires_at > now());

-- Agent monitoring state (polling cursors, last run, errors)
CREATE TABLE IF NOT EXISTS boss_agent_state (
  tenant_id text NOT NULL DEFAULT 'default',
  agent_handle text NOT NULL,
  state_key text NOT NULL,
  state_value jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, agent_handle, state_key)
);

CREATE INDEX idx_agent_state_updated ON boss_agent_state(tenant_id, agent_handle, updated_at DESC);

-- WhatsApp message monitoring assignments
CREATE TABLE IF NOT EXISTS boss_whatsapp_monitors (
  tenant_id text NOT NULL DEFAULT 'default',
  chat_id text NOT NULL,
  agent_handle text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  confidence_threshold real DEFAULT 0.85, -- Auto-send if confidence > this
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, chat_id, agent_handle),
  FOREIGN KEY (tenant_id, chat_id) REFERENCES boss_whatsapp_threads(tenant_id, chat_id) ON DELETE CASCADE
);

CREATE INDEX idx_whatsapp_monitors_agent ON boss_whatsapp_monitors(tenant_id, agent_handle) WHERE enabled;

-- Email monitoring assignments (which accounts/labels each agent watches)
CREATE TABLE IF NOT EXISTS boss_email_monitors (
  tenant_id text NOT NULL DEFAULT 'default',
  account_id text NOT NULL, -- Google/Microsoft account ID
  label_filter text, -- NULL = all, or specific label like 'INBOX'
  agent_handle text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  auto_draft boolean NOT NULL DEFAULT true,
  auto_send boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, account_id, agent_handle)
);

CREATE INDEX idx_email_monitors_agent ON boss_email_monitors(tenant_id, agent_handle) WHERE enabled;

-- Insert Spanky's WhatsApp monitoring assignments
INSERT INTO boss_whatsapp_monitors (tenant_id, chat_id, agent_handle, confidence_threshold)
VALUES
  ('default', '120363408082202008@g.us', 'spanky', 0.90), -- Agentic Team group
  ('default', '30992551153826@lid', 'spanky', 0.85) -- Kane Minkus
ON CONFLICT DO NOTHING;

COMMENT ON TABLE boss_agent_decisions IS 'Agent decision log for learning from human feedback';
COMMENT ON TABLE boss_push_notifications IS 'Browser push notifications for human approval/review';
COMMENT ON TABLE boss_agent_state IS 'Agent monitoring state (cursors, last run times, error state)';
COMMENT ON TABLE boss_whatsapp_monitors IS 'WhatsApp chat → agent monitoring assignments';
COMMENT ON TABLE boss_email_monitors IS 'Email account/label → agent monitoring assignments';
