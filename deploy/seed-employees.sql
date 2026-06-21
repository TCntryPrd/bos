-- BOS prebuilt Employee Agents — table + 4 default agents.
-- Idempotent + install-agnostic: targets the install's own workspace tenant
-- (whatever UUID it is), so it works on every box. Safe to re-run.

CREATE TABLE IF NOT EXISTS public.boss_outsiders (
    tenant_id text DEFAULT 'default'::text NOT NULL,
    handle text NOT NULL,
    display_name text NOT NULL,
    cli text NOT NULL,
    client text NOT NULL,
    project_dir text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    model text DEFAULT 'claude-sonnet-4-6'::text NOT NULL,
    CONSTRAINT boss_outsiders_cli_ck CHECK ((cli = ANY (ARRAY['claude'::text, 'ollama'::text]))),
    CONSTRAINT boss_outsiders_handle_ck CHECK ((handle ~ '^[a-z]{2,24}$'::text)),
    CONSTRAINT boss_outsiders_pkey PRIMARY KEY (tenant_id, handle)
);
CREATE INDEX IF NOT EXISTS idx_boss_outsiders_enabled
    ON public.boss_outsiders USING btree (tenant_id, enabled) WHERE (enabled = true);

-- Resolve the workspace tenant (the one registered users belong to). Falls back
-- to 'default' if the tenants table is empty at seed time.
INSERT INTO public.boss_outsiders (tenant_id, handle, display_name, cli, client, project_dir, enabled)
SELECT t.tid, v.handle, v.display_name, 'claude', v.client, v.project_dir, true
FROM (SELECT COALESCE((SELECT id::text FROM public.tenants ORDER BY created_at LIMIT 1), 'default') AS tid) t
CROSS JOIN (VALUES
  ('support','Customer Service','Customer Service','/home/boss/boss-dev/agents/employees/support'),
  ('social','Social Media','Social Media','/home/boss/boss-dev/agents/employees/social'),
  ('inbox','Email & Calendar','Email & Calendar','/home/boss/boss-dev/agents/employees/inbox'),
  ('content','Content Creation','Content Creation','/home/boss/boss-dev/agents/employees/content')
) AS v(handle, display_name, client, project_dir)
ON CONFLICT (tenant_id, handle) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      client       = EXCLUDED.client,
      project_dir  = EXCLUDED.project_dir,
      enabled      = true;
