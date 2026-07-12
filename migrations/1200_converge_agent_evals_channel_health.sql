\restrict oOqaAbobGifhpgsYnmUikoBcAyt5Vamnd8XWlTv87SX53uqEFpMFUygPhroqoLr
CREATE TABLE public.boss_agent_evals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    run_id uuid NOT NULL,
    agent_id text,
    agent_name text,
    verdict text NOT NULL,
    score numeric,
    issue text,
    evaluated_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.boss_agent_evals OWNER TO boss;
CREATE TABLE public.boss_channel_messages (
    id bigint NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    channel text NOT NULL,
    provider_message_id text NOT NULL,
    direction text DEFAULT 'inbound'::text NOT NULL,
    sender text,
    recipient text,
    body text,
    conversation_id text,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.boss_channel_messages OWNER TO boss;
CREATE SEQUENCE public.boss_channel_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.boss_channel_messages_id_seq OWNER TO boss;
ALTER SEQUENCE public.boss_channel_messages_id_seq OWNED BY public.boss_channel_messages.id;
CREATE TABLE public.health_diagnostics (
    device_id uuid NOT NULL,
    record_type text NOT NULL,
    granted boolean NOT NULL,
    has_local_data boolean NOT NULL,
    reported_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.health_diagnostics OWNER TO boss;
ALTER TABLE ONLY public.boss_channel_messages ALTER COLUMN id SET DEFAULT nextval('public.boss_channel_messages_id_seq'::regclass);
ALTER TABLE ONLY public.boss_agent_evals
    ADD CONSTRAINT boss_agent_evals_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.boss_agent_evals
    ADD CONSTRAINT boss_agent_evals_run_id_key UNIQUE (run_id);
ALTER TABLE ONLY public.boss_channel_messages
    ADD CONSTRAINT boss_channel_messages_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.boss_channel_messages
    ADD CONSTRAINT boss_channel_messages_tenant_id_channel_provider_message_id_key UNIQUE (tenant_id, channel, provider_message_id);
ALTER TABLE ONLY public.health_diagnostics
    ADD CONSTRAINT health_diagnostics_pkey PRIMARY KEY (device_id, record_type);
CREATE INDEX idx_agent_evals_when ON public.boss_agent_evals USING btree (evaluated_at DESC);
ALTER TABLE ONLY public.health_diagnostics
    ADD CONSTRAINT health_diagnostics_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.health_devices(id) ON DELETE CASCADE;
\unrestrict oOqaAbobGifhpgsYnmUikoBcAyt5Vamnd8XWlTv87SX53uqEFpMFUygPhroqoLr
