/**
 * WebSocket server for Voice PE device connections.
 *
 * Protocol (JSON messages over WebSocket):
 *
 * Client -> Server:
 *   { type: 'register', deviceId, room, ipAddress }
 *   { type: 'audio', deviceId, tenantId, userId, data: <base64 WAV>, language? }
 *   { type: 'ping', deviceId }
 *
 * Server -> Client:
 *   { type: 'registered', deviceId, room }
 *   { type: 'audio', data: <base64>, format: 'mp3'|'pcm'|'wav', transcript, reply }
 *   { type: 'error', message }
 *   { type: 'pong', deviceId }
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { DeviceRegistry } from './devices.js';
import { VoicePipeline } from './pipeline.js';
import type { PipelineBrainAdapter } from './pipeline.js';
import type { STTEngine } from './stt/engine.js';
import type { TTSEngine } from './tts/engine.js';

// ── Message types ─────────────────────────────────────────────

type ClientMessage =
  | { type: 'register'; deviceId: string; room: string; ipAddress: string }
  | { type: 'audio'; deviceId: string; tenantId: string; userId: string; data: string; language?: string }
  | { type: 'ping'; deviceId: string };

type ServerMessage =
  | { type: 'registered'; deviceId: string; room: string }
  | { type: 'audio'; data: string; format: string; transcript: string; reply: string; latency: Record<string, number> }
  | { type: 'error'; message: string }
  | { type: 'pong'; deviceId: string };

// ── Server config ─────────────────────────────────────────────

export interface VoiceServerConfig {
  /** Port to listen on. Default: 8765 */
  port?: number;
  /** Attach to an existing HTTP server instead of creating one. */
  server?: Server;
  stt: STTEngine;
  tts: TTSEngine;
  brain: PipelineBrainAdapter;
}

// ── VoiceServer ───────────────────────────────────────────────

export class VoiceServer {
  private wss: WebSocketServer;
  readonly registry: DeviceRegistry;
  private pipeline: VoicePipeline;

  constructor(config: VoiceServerConfig) {
    this.registry = new DeviceRegistry();

    this.pipeline = new VoicePipeline({
      stt: config.stt,
      tts: config.tts,
      brain: config.brain,
      devices: this.registry,
    });

    this.wss = config.server
      ? new WebSocketServer({ server: config.server })
      : new WebSocketServer({ port: config.port ?? 8765 });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (err: Error) => {
      console.error('[VoiceServer] WebSocket server error:', err.message);
    });
  }

  // ── Connection handler ────────────────────────────────────

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const remoteIp = req.socket.remoteAddress ?? 'unknown';
    console.log(`[VoiceServer] New connection from ${remoteIp}`);

    ws.on('message', (raw: Buffer) => {
      this.handleMessage(ws, raw, remoteIp).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.send(ws, { type: 'error', message: msg });
      });
    });

    ws.on('close', () => {
      this.handleDisconnect(ws);
    });

    ws.on('error', (err: Error) => {
      console.error(`[VoiceServer] Client error from ${remoteIp}:`, err.message);
    });
  }

  private async handleMessage(ws: WebSocket, raw: Buffer, remoteIp: string): Promise<void> {
    let msg: ClientMessage;

    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      this.send(ws, { type: 'error', message: 'Invalid JSON message' });
      return;
    }

    switch (msg.type) {
      case 'register': {
        const device = this.registry.register(
          {
            deviceId: msg.deviceId,
            room: msg.room,
            ipAddress: msg.ipAddress || remoteIp,
          },
          ws,
        );
        console.log(`[VoiceServer] Device registered: ${device.id} (${device.room})`);
        this.send(ws, { type: 'registered', deviceId: device.id, room: device.room });
        break;
      }

      case 'audio': {
        const device = this.registry.get(msg.deviceId);
        if (!device) {
          this.send(ws, { type: 'error', message: 'Device not registered. Send register first.' });
          return;
        }

        this.registry.setStatus(msg.deviceId, 'listening');

        const audioBuffer = Buffer.from(msg.data, 'base64');

        const result = await this.pipeline.process({
          deviceId: msg.deviceId,
          tenantId: msg.tenantId,
          userId: msg.userId,
          audio: audioBuffer,
          language: msg.language,
        });

        this.registry.setStatus(msg.deviceId, 'responding');

        this.send(ws, {
          type: 'audio',
          data: result.audio.toString('base64'),
          format: result.audioFormat,
          transcript: result.transcript,
          reply: result.reply,
          latency: result.latency,
        });

        this.registry.setStatus(msg.deviceId, 'idle');
        break;
      }

      case 'ping': {
        this.registry.heartbeat(msg.deviceId);
        this.send(ws, { type: 'pong', deviceId: msg.deviceId });
        break;
      }

      default: {
        this.send(ws, { type: 'error', message: `Unknown message type` });
      }
    }
  }

  private handleDisconnect(ws: WebSocket): void {
    // Find which device owns this socket and mark offline
    for (const device of this.registry.list()) {
      if (device.socket === ws) {
        console.log(`[VoiceServer] Device disconnected: ${device.id} (${device.room})`);
        this.registry.disconnect(device.id);
        break;
      }
    }
  }

  // ── Utilities ─────────────────────────────────────────────

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Send audio to a specific device by ID (server-initiated, e.g. escalation announcement).
   */
  sendToDevice(deviceId: string, msg: ServerMessage): boolean {
    const device = this.registry.get(deviceId);
    if (!device?.socket) return false;
    this.send(device.socket, msg);
    return true;
  }

  /**
   * Send audio to a device in a specific room.
   */
  sendToRoom(room: string, msg: ServerMessage): boolean {
    const device = this.registry.getByRoom(room);
    if (!device?.socket) return false;
    this.send(device.socket, msg);
    return true;
  }

  /**
   * Broadcast to all connected devices.
   */
  broadcast(msg: ServerMessage): void {
    for (const device of this.registry.listOnline()) {
      if (device.socket) {
        this.send(device.socket, msg);
      }
    }
  }

  close(): void {
    this.wss.close();
  }

  get clientCount(): number {
    return this.wss.clients.size;
  }
}
