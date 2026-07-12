-- 036_health_data.sql — Health Connect ingest (spec 2026-07-01-health-connect-bridge-design)

CREATE TABLE IF NOT EXISTS health_devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL DEFAULT 'default',
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  token_hash   TEXT UNIQUE,
  paired_at    TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS health_pairing_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  UUID NOT NULL REFERENCES health_devices(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS health_records (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL DEFAULT 'default',
  user_id     TEXT NOT NULL,
  device_id   UUID NOT NULL REFERENCES health_devices(id),
  record_type TEXT NOT NULL,
  record_uid  TEXT NOT NULL,
  start_ts    TIMESTAMPTZ NOT NULL,
  end_ts      TIMESTAMPTZ,
  day         DATE NOT NULL,
  source_app  TEXT,
  payload     JSONB NOT NULL DEFAULT '{}',
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, record_type, record_uid)
);
CREATE INDEX IF NOT EXISTS idx_health_records_day
  ON health_records (tenant_id, day DESC, record_type);
CREATE INDEX IF NOT EXISTS idx_health_records_type_ts
  ON health_records (tenant_id, record_type, start_ts DESC);

CREATE TABLE IF NOT EXISTS health_daily (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  TEXT NOT NULL DEFAULT 'default',
  user_id    TEXT NOT NULL,
  day        DATE NOT NULL,
  metric     TEXT NOT NULL,
  value      NUMERIC NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, day, metric)
);
CREATE INDEX IF NOT EXISTS idx_health_daily_day
  ON health_daily (tenant_id, day DESC);

CREATE TABLE IF NOT EXISTS health_sync_state (
  device_id      UUID NOT NULL REFERENCES health_devices(id) ON DELETE CASCADE,
  record_type    TEXT NOT NULL,
  last_record_ts TIMESTAMPTZ,
  records_total  BIGINT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, record_type)
);

DROP TRIGGER IF EXISTS trg_health_devices_updated_at ON health_devices;
CREATE TRIGGER trg_health_devices_updated_at
  BEFORE UPDATE ON health_devices
  FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

DROP TRIGGER IF EXISTS trg_health_records_updated_at ON health_records;
CREATE TRIGGER trg_health_records_updated_at
  BEFORE UPDATE ON health_records
  FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();
