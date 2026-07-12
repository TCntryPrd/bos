-- =============================================================================
-- IR Custom AIOS v2 — Migration 006: Voice Devices
-- Tables: voice_devices
-- Supports: room-aware voice assistant hardware (Raspberry Pi, Alexa Echo, custom)
-- Depends on: 001_foundation.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- VOICE_DEVICES
-- Registry of hardware voice devices connected to the system.
-- One row per physical device per tenant. device_id is the hardware identifier
-- (MAC address, serial, or custom slug assigned at enrollment).
-- The conversations table references device_id (VARCHAR) not this UUID
-- so that conversation records survive device re-provisioning.
-- ---------------------------------------------------------------------------
CREATE TABLE voice_devices (
    id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    device_id           VARCHAR(100)    NOT NULL,       -- hardware identifier (MAC, serial, or slug)
    name                VARCHAR(255)    NOT NULL,       -- human name: "Kitchen", "Home Office"
    room                VARCHAR(100)    NOT NULL,       -- room label used for context injection
    device_type         VARCHAR(50)     NOT NULL DEFAULT 'custom'
                            CHECK (device_type IN ('raspberry_pi', 'alexa', 'google_home', 'custom')),
    status              VARCHAR(20)     NOT NULL DEFAULT 'online'
                            CHECK (status IN ('online', 'offline', 'error', 'provisioning')),
    wake_word           VARCHAR(100)    NOT NULL DEFAULT 'hey boss',
    stt_provider        VARCHAR(50)     NOT NULL DEFAULT 'whisper'
                            CHECK (stt_provider IN ('whisper', 'deepgram', 'google', 'azure', 'custom')),
    tts_provider        VARCHAR(50)     NOT NULL DEFAULT 'elevenlabs'
                            CHECK (tts_provider IN ('elevenlabs', 'openai', 'google', 'azure', 'custom')),
    last_seen_at        TIMESTAMPTZ,
    firmware_version    VARCHAR(50),
    ip_address          INET,
    config              JSONB           NOT NULL DEFAULT '{}',
    -- config keys: volume, sensitivity, doNotDisturb: {start, end}, allowedUsers: [user_ids]
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, device_id)
);

COMMENT ON TABLE voice_devices IS
    'Registry of physical voice-enabled devices. '
    'room is used by the Brain Router context middleware to inject location-aware context. '
    'status is updated by the heartbeat monitor every 30 seconds. '
    'config.doNotDisturb suppresses voice responses during quiet hours. '
    'config.allowedUsers restricts which users this device responds to (empty = all).';

COMMENT ON COLUMN voice_devices.device_id IS
    'Hardware identifier assigned at enrollment. Stable across reboots and re-registration. '
    'Conversations reference this field by value so records survive device replacement.';

COMMENT ON COLUMN voice_devices.room IS
    'Room label injected into brain context for location-aware responses. '
    'Examples: kitchen, home_office, living_room, bedroom.';

COMMENT ON COLUMN voice_devices.config IS
    'Device-level config JSON. Keys: volume (0-100), sensitivity (0-1), '
    'doNotDisturb: {start: "22:00", end: "07:00"}, allowedUsers: [uuid, ...]';

CREATE INDEX idx_voice_devices_tenant_id ON voice_devices(tenant_id);
CREATE INDEX idx_voice_devices_status ON voice_devices(tenant_id, status);
CREATE INDEX idx_voice_devices_room ON voice_devices(tenant_id, room);

CREATE TRIGGER trg_voice_devices_updated_at
    BEFORE UPDATE ON voice_devices
    FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();
