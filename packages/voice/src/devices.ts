/**
 * Voice device registry.
 * Tracks Home Assistant Voice PE satellites — room assignment, connection status, last seen.
 */

import type { WebSocket } from 'ws';

export type DeviceStatus = 'online' | 'offline' | 'idle' | 'listening' | 'responding';

export interface VoiceDevice {
  /** Stable device identifier — set by the device during registration. */
  id: string;
  /** Friendly room label, e.g. "office", "bedroom", "kitchen". */
  room: string;
  /** IP address of the device on the LAN. */
  ipAddress: string;
  /** Current connection state. */
  status: DeviceStatus;
  /** Timestamp of the last received message or ping from this device. */
  lastSeenAt: Date;
  /** Timestamp when the device first registered. */
  registeredAt: Date;
  /** Active WebSocket connection — undefined when device is offline. */
  socket?: WebSocket;
}

export interface DeviceRegistration {
  deviceId: string;
  room: string;
  ipAddress: string;
}

export class DeviceRegistry {
  private devices = new Map<string, VoiceDevice>();

  /**
   * Register a device (or update its registration if it reconnects).
   * Returns the stored VoiceDevice record.
   */
  register(registration: DeviceRegistration, socket: WebSocket): VoiceDevice {
    const existing = this.devices.get(registration.deviceId);

    const device: VoiceDevice = {
      id: registration.deviceId,
      room: registration.room,
      ipAddress: registration.ipAddress,
      status: 'idle',
      lastSeenAt: new Date(),
      registeredAt: existing?.registeredAt ?? new Date(),
      socket,
    };

    this.devices.set(device.id, device);
    return device;
  }

  /**
   * Mark a device offline and clear its socket reference.
   */
  disconnect(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) {
      device.status = 'offline';
      device.socket = undefined;
    }
  }

  /**
   * Update the last-seen timestamp (called on heartbeat / ping).
   */
  heartbeat(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastSeenAt = new Date();
    }
  }

  /**
   * Update the status of a device.
   */
  setStatus(deviceId: string, status: DeviceStatus): void {
    const device = this.devices.get(deviceId);
    if (device) {
      device.status = status;
    }
  }

  /**
   * Look up a device by ID.
   */
  get(deviceId: string): VoiceDevice | undefined {
    return this.devices.get(deviceId);
  }

  /**
   * Find a device by room name (case-insensitive).
   * Returns the first match if multiple devices are in the same room.
   */
  getByRoom(room: string): VoiceDevice | undefined {
    const target = room.toLowerCase();
    for (const device of this.devices.values()) {
      if (device.room.toLowerCase() === target) {
        return device;
      }
    }
    return undefined;
  }

  /**
   * Return all currently registered devices (including offline).
   */
  list(): VoiceDevice[] {
    return Array.from(this.devices.values());
  }

  /**
   * Return only devices that are currently connected (not offline).
   */
  listOnline(): VoiceDevice[] {
    return this.list().filter((d) => d.status !== 'offline');
  }

  /**
   * Return the count of online devices.
   */
  onlineCount(): number {
    return this.listOnline().length;
  }

  /**
   * Remove all offline devices that haven't been seen for longer than the given threshold.
   * @param maxAgeMs - Maximum age in ms before an offline device is pruned. Default: 24h
   */
  pruneStale(maxAgeMs = 86_400_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, device] of this.devices) {
      if (device.status === 'offline' && device.lastSeenAt.getTime() < cutoff) {
        this.devices.delete(id);
      }
    }
  }
}
