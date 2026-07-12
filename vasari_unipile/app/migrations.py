UNIPILE_SCHEMA_SQL = """
CREATE SCHEMA IF NOT EXISTS unipile;

CREATE TABLE IF NOT EXISTS unipile.schema_migration (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unipile.account (
  id bigserial PRIMARY KEY,
  unipile_account_id text UNIQUE NOT NULL,
  provider text NOT NULL DEFAULT 'LINKEDIN',
  owner_agent text,
  public_identifier text,
  member_urn text,
  display_name text,
  premium_tier text DEFAULT 'none',
  connections_count integer DEFAULT 0,
  status text DEFAULT 'CONNECTING',
  last_status_at timestamptz,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unipile.profile (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES unipile.account(id),
  provider_id text NOT NULL,
  public_identifier text,
  member_urn text,
  full_name text,
  first_name text,
  last_name text,
  headline text,
  location text,
  industry text,
  profile_url text,
  public_profile_url text,
  picture_url text,
  is_open_profile boolean,
  is_premium boolean,
  network_distance text,
  current_company text,
  current_role_title text,
  raw jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_enriched_at timestamptz,
  UNIQUE (account_id, provider_id)
);

CREATE TABLE IF NOT EXISTS unipile.connection (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES unipile.account(id),
  profile_id bigint NOT NULL REFERENCES unipile.profile(id),
  source text,
  connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, profile_id)
);

CREATE TABLE IF NOT EXISTS unipile.invitation (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES unipile.account(id),
  profile_id bigint REFERENCES unipile.profile(id),
  provider_id text NOT NULL,
  direction text NOT NULL DEFAULT 'sent',
  status text NOT NULL DEFAULT 'queued',
  has_note boolean DEFAULT false,
  note_text text,
  unipile_invitation_id text,
  sent_at timestamptz,
  responded_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unipile.chat (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES unipile.account(id),
  unipile_chat_id text UNIQUE NOT NULL,
  chat_provider_id text,
  attendee_provider_id text,
  name text,
  is_group boolean DEFAULT false,
  inbox_feature text,
  unread_count integer DEFAULT 0,
  archived boolean DEFAULT false,
  last_message_at timestamptz,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unipile.message (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES unipile.account(id),
  chat_id bigint REFERENCES unipile.chat(id),
  unipile_message_id text UNIQUE NOT NULL,
  provider_id text,
  sender_provider_id text,
  is_sender boolean,
  text text,
  message_type text,
  event_type integer DEFAULT 0,
  seen boolean,
  delivered boolean,
  hidden boolean,
  deleted boolean,
  edited boolean,
  attachments jsonb,
  quoted jsonb,
  reactions jsonb,
  timestamp timestamptz,
  raw jsonb,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unipile.post (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES unipile.account(id),
  social_id text NOT NULL,
  linkedin_id text,
  share_url text,
  is_owned boolean DEFAULT false,
  author_provider_id text,
  author_name text,
  author_is_company boolean,
  text text,
  posted_at timestamptz,
  reaction_counter integer,
  comment_counter integer,
  repost_counter integer,
  impressions_counter integer,
  permissions jsonb,
  attachments jsonb,
  raw jsonb,
  last_polled_at timestamptz,
  UNIQUE (account_id, social_id)
);

CREATE TABLE IF NOT EXISTS unipile.post_reaction (
  id bigserial PRIMARY KEY,
  post_id bigint NOT NULL REFERENCES unipile.post(id),
  reactor_provider_id text,
  reactor_name text,
  reaction_value text,
  is_sender boolean,
  raw jsonb,
  seen_at timestamptz DEFAULT now(),
  UNIQUE (post_id, reactor_provider_id)
);

CREATE TABLE IF NOT EXISTS unipile.post_comment (
  id bigserial PRIMARY KEY,
  post_id bigint NOT NULL REFERENCES unipile.post(id),
  unipile_comment_id text,
  author_provider_id text,
  author_name text,
  text text,
  parent_comment_id text,
  is_ours boolean DEFAULT false,
  commented_at timestamptz,
  raw jsonb,
  UNIQUE (post_id, unipile_comment_id)
);

CREATE TABLE IF NOT EXISTS unipile.engagement_action (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES unipile.account(id),
  action_type text NOT NULL,
  target_type text NOT NULL,
  target_ref text NOT NULL,
  payload jsonb,
  status text NOT NULL DEFAULT 'queued',
  unipile_ref text,
  error_code text,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unipile.search_run (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES unipile.account(id),
  api text,
  category text,
  params jsonb,
  source_url text,
  requested_by text,
  total_count integer,
  fetched_count integer,
  status text DEFAULT 'running',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unipile.search_result (
  id bigserial PRIMARY KEY,
  search_run_id bigint NOT NULL REFERENCES unipile.search_run(id),
  position integer,
  entity_type text,
  provider_id text,
  social_id text,
  name text,
  headline text,
  location text,
  network_distance text,
  open_profile boolean,
  pending_invitation boolean,
  profile_url text,
  profile_id bigint REFERENCES unipile.profile(id),
  raw jsonb
);

CREATE TABLE IF NOT EXISTS unipile.campaign (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES unipile.account(id),
  name text NOT NULL,
  icp_definition jsonb,
  templates jsonb,
  daily_caps jsonb,
  is_default boolean DEFAULT false,
  status text DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unipile.prospect (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES unipile.account(id),
  profile_id bigint NOT NULL REFERENCES unipile.profile(id),
  campaign_id bigint REFERENCES unipile.campaign(id),
  stage text NOT NULL DEFAULT 'sourced',
  stage_updated_at timestamptz NOT NULL DEFAULT now(),
  next_action text,
  next_action_at timestamptz,
  assigned_agent text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, profile_id, campaign_id)
);

CREATE TABLE IF NOT EXISTS unipile.action_queue (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES unipile.account(id),
  action_type text NOT NULL,
  payload jsonb NOT NULL,
  priority integer DEFAULT 100,
  not_before timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'queued',
  attempts integer DEFAULT 0,
  last_error text,
  dedupe_key text UNIQUE,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz
);

CREATE TABLE IF NOT EXISTS unipile.rate_budget_ledger (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES unipile.account(id),
  action_type text NOT NULL,
  day date NOT NULL,
  count integer NOT NULL DEFAULT 0,
  cap integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, action_type, day)
);

CREATE TABLE IF NOT EXISTS unipile.webhook_event (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  event_type text,
  unipile_ref text,
  payload jsonb NOT NULL,
  dedupe_key text UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_status text DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS unipile.audit_log (
  id bigserial PRIMARY KEY,
  actor text,
  action text,
  entity_type text,
  entity_id text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unipile_message_account_ts ON unipile.message (account_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_unipile_action_queue_ready ON unipile.action_queue (status, not_before);
CREATE INDEX IF NOT EXISTS idx_unipile_prospect_stage ON unipile.prospect (account_id, stage);
CREATE INDEX IF NOT EXISTS idx_unipile_invitation_status ON unipile.invitation (account_id, status);
CREATE INDEX IF NOT EXISTS idx_unipile_webhook_event_status ON unipile.webhook_event (processing_status, received_at);

ALTER TABLE unipile.campaign ADD COLUMN IF NOT EXISTS is_default boolean DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_unipile_campaign_default ON unipile.campaign (account_id) WHERE is_default;

INSERT INTO unipile.schema_migration (version)
VALUES ('m0_20260701')
ON CONFLICT (version) DO NOTHING;
"""
