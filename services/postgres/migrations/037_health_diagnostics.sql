-- 037_health_diagnostics.sql — Health Connect diagnostics reporting (spec 2026-07-06-health-diagnostics-design)
-- Current snapshot per device+type of Health Connect permission/data-presence state.
-- No history — health_sync_state already carries the historical/volume signal.

CREATE TABLE IF NOT EXISTS health_diagnostics (
  device_id      UUID NOT NULL REFERENCES health_devices(id) ON DELETE CASCADE,
  record_type    TEXT NOT NULL,
  granted        BOOLEAN NOT NULL,
  has_local_data BOOLEAN NOT NULL,
  reported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, record_type)
);
