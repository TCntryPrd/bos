import { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Smartphone, Trash2, X } from 'lucide-react';
import { ConfirmDialog } from '../ConfirmDialog';
import { healthDataApi } from '../../lib/healthData';
import type { HealthDevice } from '../../lib/healthData';

function freshness(d: HealthDevice): string {
  if (d.revoked_at) return 'revoked';
  if (!d.paired_at) return 'pairing pending';
  if (!d.last_seen_at) return 'paired, never synced';
  const mins = Math.round((Date.now() - Date.parse(d.last_seen_at)) / 60_000);
  if (mins < 60) return `active ${mins}m ago`;
  if (mins < 60 * 24) return `active ${Math.round(mins / 60)}h ago`;
  return `active ${Math.round(mins / (60 * 24))}d ago`;
}

function secondsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000));
}

export function DevicesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [devices, setDevices] = useState<HealthDevice[]>([]);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [revoking, setRevoking] = useState<HealthDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [devicePlatform, setDevicePlatform] = useState<'android' | 'ios'>('android');
  const [remaining, setRemaining] = useState(0);

  const load = useCallback(() => {
    healthDataApi.devices()
      .then(({ devices }) => { setDevices(devices); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!open) { setPairing(null); setError(null); return; }
    load();
  }, [open, load]);

  // Live countdown against the server-issued pairing expiry, so a stale
  // QR/code is visibly marked as expired instead of looking valid forever.
  useEffect(() => {
    if (!pairing) { setRemaining(0); return; }
    setRemaining(secondsLeft(pairing.expiresAt));
    const id = setInterval(() => setRemaining(secondsLeft(pairing.expiresAt)), 1000);
    return () => clearInterval(id);
  }, [pairing]);

  useEffect(() => {
    if (!open) return;
    // While the revoke confirmation is open, let ConfirmDialog's own
    // Escape handler own the keypress — otherwise both handlers fire on
    // the same keydown and Escape closes this whole modal too.
    if (revoking) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose, revoking]);

  if (!open) return null;

  const addDevice = () => {
    const name = deviceName.trim();
    if (!name) { setError('Enter a device name'); return; }
    healthDataApi.mintDevice(name, devicePlatform)
      .then((r) => {
        setPairing({ code: r.pairing_code, expiresAt: r.expires_at });
        setDeviceName('');
        setError(null);
        load();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const expired = !!pairing && remaining <= 0;
  const qrValue = pairing && !expired
    ? JSON.stringify({ v: 1, server: window.location.origin, code: pairing.code })
    : '';
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
      role="dialog" aria-modal="true" onClick={onClose}>
      <div className="bg-surface-2 border border-border rounded-xl shadow-2xl w-full max-w-md p-5 animate-slide-in"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-4">
          <Smartphone size={16} className="text-text-secondary" />
          <h2 className="text-sm font-semibold text-text-primary">Health devices</h2>
          <button className="btn-ghost !p-1 ml-auto" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        {error && <div className="badge badge-danger mb-3">{error}</div>}

        {devices.filter((d) => !d.revoked_at).map((d) => (
          <div key={d.id} className="border border-border rounded-lg p-3 mb-2">
            <div className="flex items-center gap-2">
              <div className="text-sm text-text-primary">{d.name}</div>
              <div className="text-[10.5px] text-text-muted">{d.platform}</div>
              <div className="text-[10.5px] text-text-muted ml-auto">{freshness(d)}</div>
              <button className="btn-ghost !p-1" aria-label={`Revoke ${d.name}`}
                onClick={() => setRevoking(d)}>
                <Trash2 size={13} className="text-danger" />
              </button>
            </div>
            {d.sync_state.length > 0 && (
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
                {d.sync_state.map((s) => (
                  <div key={s.record_type} className="flex justify-between text-[10.5px]">
                    <span className="text-text-muted">{s.record_type}</span>
                    <span className="text-text-secondary">
                      {s.last_record_ts
                        ? new Date(s.last_record_ts).toLocaleDateString('en-US',
                            { month: 'short', day: 'numeric' })
                        : '—'} · {s.records_total}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {devices.filter((d) => !d.revoked_at).length === 0 && !pairing && (
          <p className="text-xs text-text-muted mb-3">No devices paired.</p>
        )}

        {pairing ? (
          <div className="border border-border rounded-lg p-4 text-center">
            {expired ? (
              <p className="text-xs text-danger py-6">
                This code expired. Start over to pair the device.
              </p>
            ) : (
              <>
                <div className="flex justify-center mb-3 bg-white p-3 rounded-lg w-fit mx-auto">
                  <QRCodeSVG value={qrValue} size={160} level="M" />
                </div>
                <div className="font-mono text-xl tracking-[0.3em] text-text-primary">{pairing.code}</div>
                <p className="text-[11px] text-text-muted mt-2">
                  Scan the QR or enter this code in the BOS Health app.
                  The code works once and expires in{' '}
                  <span className="font-mono">{mm}:{String(ss).padStart(2, '0')}</span>.
                </p>
              </>
            )}
            <button className="btn-secondary w-full justify-center mt-3" onClick={() => setPairing(null)}>
              {expired ? 'Start over' : 'Cancel'}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-text-secondary">Device name</span>
              <input
                className="input"
                placeholder="Device name (e.g. Pixel 9)"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                maxLength={64}
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-text-secondary">Platform</span>
              <select
                className="input"
                value={devicePlatform}
                onChange={(e) => setDevicePlatform(e.target.value as 'android' | 'ios')}
              >
                <option value="android">Android</option>
                <option value="ios">iOS</option>
              </select>
            </label>
            <button className="btn-primary w-full justify-center" onClick={addDevice}>
              Add device
            </button>
          </div>
        )}

        <ConfirmDialog
          open={revoking !== null}
          title={`Revoke ${revoking?.name ?? ''}?`}
          description="The device's token stops working immediately. Already-synced data is kept."
          confirmLabel="Revoke"
          onCancel={() => setRevoking(null)}
          onConfirm={() => {
            if (!revoking) return;
            healthDataApi.revokeDevice(revoking.id)
              .then(() => { setRevoking(null); load(); })
              .catch((e) => { setRevoking(null); setError(e instanceof Error ? e.message : String(e)); });
          }}
        />
      </div>
    </div>
  );
}
