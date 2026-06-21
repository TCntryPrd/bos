/**
 * Voice Devices — list of connected Voice PE satellites, room assignments, status.
 */

import React, { useState } from 'react';
import {
  Mic2,
  RefreshCw,
  MapPin,
  Clock,
  Cpu,
  Wifi,
  WifiOff,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { Card } from '../components/Card';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { PageLoader } from '../components/LoadingSpinner';
import { useApi } from '../hooks/useApi';
import { voiceApi } from '../lib/api';
import { mockVoiceDevices } from '../lib/mock';
import { formatRelativeTime, formatUptime } from '../lib/utils';
import type { VoiceDevice } from '../types/api';

const STATUS_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  online:       Wifi,
  offline:      WifiOff,
  error:        AlertCircle,
  provisioning: Loader2,
};

function DeviceCard({ device, onRefresh }: { device: VoiceDevice; onRefresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [roomInput, setRoomInput] = useState(device.room);
  const [saving, setSaving] = useState(false);

  const StatusIcon = STATUS_ICONS[device.status] ?? Wifi;

  async function handleSaveRoom() {
    if (roomInput.trim() === device.room) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await voiceApi.updateDevice(device.id, { room: roomInput.trim() });
      onRefresh();
      setEditing(false);
    } catch {
      // Revert on error
      setRoomInput(device.room);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card overflow-hidden">
      {/* Card top — status color strip */}
      <div
        className={`h-1 w-full ${
          device.status === 'online'
            ? 'bg-success'
            : device.status === 'offline'
            ? 'bg-danger'
            : device.status === 'error'
            ? 'bg-danger'
            : 'bg-warning'
        }`}
        aria-hidden
      />

      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-surface-3">
              <StatusIcon
                className={`w-4 h-4 ${
                  device.status === 'online' ? 'text-success' :
                  device.status === 'offline' ? 'text-danger' :
                  device.status === 'provisioning' ? 'text-warning animate-spin' :
                  'text-danger'
                }`}
                aria-hidden
              />
            </div>
            <div>
              <p className="text-sm font-semibold text-text-primary">{device.name}</p>
              {device.ipAddress && (
                <p className="text-xs text-text-muted font-mono">{device.ipAddress}</p>
              )}
            </div>
          </div>
          <StatusBadge status={device.status} size="sm" />
        </div>

        <dl className="space-y-2.5">
          {/* Room — editable */}
          <div className="flex items-center justify-between gap-2">
            <dt className="flex items-center gap-1.5 text-xs text-text-muted flex-shrink-0">
              <MapPin className="w-3.5 h-3.5" aria-hidden />
              Room
            </dt>
            <dd className="text-xs text-text-secondary font-medium min-w-0">
              {editing ? (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(e) => { e.preventDefault(); handleSaveRoom(); }}
                >
                  <input
                    className="input py-0.5 px-2 h-6 text-xs w-28"
                    value={roomInput}
                    onChange={(e) => setRoomInput(e.target.value)}
                    autoFocus
                    aria-label="Room name"
                  />
                  <button
                    type="submit"
                    className="btn-primary py-0.5 px-2 h-6 text-xs"
                    disabled={saving}
                    aria-label="Save room name"
                  >
                    {saving ? '...' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost py-0.5 px-1.5 h-6 text-xs"
                    onClick={() => { setRoomInput(device.room); setEditing(false); }}
                    aria-label="Cancel editing"
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  className="text-xs text-text-secondary hover:text-accent transition-colors"
                  onClick={() => setEditing(true)}
                  aria-label={`Edit room — currently ${device.room}`}
                >
                  {device.room}
                </button>
              )}
            </dd>
          </div>

          {/* Wake word */}
          <div className="flex items-center justify-between gap-2">
            <dt className="flex items-center gap-1.5 text-xs text-text-muted flex-shrink-0">
              <Mic2 className="w-3.5 h-3.5" aria-hidden />
              Wake Word
            </dt>
            <dd className="text-xs text-text-secondary font-medium">{device.wakeWord}</dd>
          </div>

          {/* Firmware */}
          {device.firmwareVersion && (
            <div className="flex items-center justify-between gap-2">
              <dt className="flex items-center gap-1.5 text-xs text-text-muted flex-shrink-0">
                <Cpu className="w-3.5 h-3.5" aria-hidden />
                Firmware
              </dt>
              <dd className="text-xs text-text-secondary font-mono">{device.firmwareVersion}</dd>
            </div>
          )}

          {/* Last Activity */}
          {device.lastActivity && (
            <div className="flex items-center justify-between gap-2">
              <dt className="flex items-center gap-1.5 text-xs text-text-muted flex-shrink-0">
                <Clock className="w-3.5 h-3.5" aria-hidden />
                Last Activity
              </dt>
              <dd className="text-xs text-text-secondary">
                {formatRelativeTime(device.lastActivity)}
              </dd>
            </div>
          )}

          {/* Uptime */}
          {device.uptime !== undefined && device.status === 'online' && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-xs text-text-muted flex-shrink-0">Uptime</dt>
              <dd className="text-xs text-text-secondary font-mono">
                {formatUptime(device.uptime)}
              </dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}

export function VoiceDevices() {
  const { data: devices, isLoading, refresh } = useApi(
    voiceApi.getDevices,
    { fallback: mockVoiceDevices, pollInterval: 15_000 },
  );

  const online = devices?.filter((d) => d.status === 'online').length ?? 0;
  const total = devices?.length ?? 0;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Summary stats */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-success" aria-hidden />
            <span className="text-sm text-text-secondary">
              <span className="font-semibold text-text-primary">{online}</span> of{' '}
              <span className="font-semibold text-text-primary">{total}</span> online
            </span>
          </div>
        </div>
        <button
          className="btn-ghost text-xs gap-1.5"
          onClick={refresh}
          aria-label="Refresh device list"
        >
          <RefreshCw className="w-3.5 h-3.5" aria-hidden />
          Refresh
        </button>
      </div>

      {isLoading && !devices ? (
        <PageLoader />
      ) : devices && devices.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {devices.map((device) => (
            <DeviceCard key={device.id} device={device} onRefresh={refresh} />
          ))}
        </div>
      ) : (
        <Card>
          <Card.Body>
            <EmptyState
              icon={<Mic2 className="w-10 h-10" />}
              title="No voice devices connected"
              description="Provision a Home Assistant Voice PE device and it will appear here once it connects to BOS."
            />
          </Card.Body>
        </Card>
      )}

      {/* Setup info */}
      <Card>
        <Card.Header title="Device Setup" subtitle="Home Assistant Voice PE provisioning guide" />
        <Card.Body>
          <ol className="space-y-3 list-none">
            {[
              'Flash ESPHome firmware to Voice PE with your tenant wake word config.',
              'Connect the device to your WiFi and ensure it can reach the BOS API.',
              'The device will auto-register on first WebSocket handshake.',
              'Assign a room label to enable room-aware voice commands.',
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-accent/15 text-accent text-xs font-semibold flex items-center justify-center mt-0.5">
                  {i + 1}
                </span>
                <span className="text-sm text-text-secondary">{step}</span>
              </li>
            ))}
          </ol>
        </Card.Body>
      </Card>
    </div>
  );
}
