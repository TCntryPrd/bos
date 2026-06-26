/**
 * WebSocket client for real-time health data.
 * Connects to the Fastify WebSocket server at /ws/health.
 * Handles reconnection with exponential backoff.
 */

import type { SystemHealth, ActivityItem } from '../types/api';

export type WsMessageType = 'health' | 'activity' | 'ping' | 'pong';

export interface WsMessage {
  type: WsMessageType;
  payload: SystemHealth | ActivityItem | null;
  timestamp: string;
}

type HealthListener = (health: SystemHealth) => void;
type ActivityListener = (item: ActivityItem) => void;
type StatusListener = (connected: boolean) => void;

class BossWebSocket {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30_000;
  private baseDelay = 1_000;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  private healthListeners: Set<HealthListener> = new Set();
  private activityListeners: Set<ActivityListener> = new Set();
  private statusListeners: Set<StatusListener> = new Set();

  private isConnected = false;
  private shouldConnect = false;

  connect(): void {
    this.shouldConnect = true;
    this.openConnection();
  }

  disconnect(): void {
    this.shouldConnect = false;
    this.cleanup();
  }

  private openConnection(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/health`;

    try {
      this.ws = new WebSocket(url);
      this.ws.onopen = this.handleOpen;
      this.ws.onmessage = this.handleMessage;
      this.ws.onclose = this.handleClose;
      this.ws.onerror = this.handleError;
    } catch {
      this.scheduleReconnect();
    }
  }

  private handleOpen = (): void => {
    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.notifyStatus(true);
    this.startPing();
  };

  private handleMessage = (event: MessageEvent): void => {
    try {
      const msg = JSON.parse(event.data as string) as WsMessage;
      if (msg.type === 'health') {
        this.healthListeners.forEach((fn) => fn(msg.payload as SystemHealth));
      } else if (msg.type === 'activity') {
        this.activityListeners.forEach((fn) => fn(msg.payload as ActivityItem));
      }
    } catch {
      // malformed message — ignore
    }
  };

  private handleClose = (): void => {
    this.isConnected = false;
    this.notifyStatus(false);
    this.stopPing();
    if (this.shouldConnect) {
      this.scheduleReconnect();
    }
  };

  private handleError = (): void => {
    this.ws?.close();
  };

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay,
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      if (this.shouldConnect) this.openConnection();
    }, delay);
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25_000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private cleanup(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.notifyStatus(false);
  }

  private notifyStatus(connected: boolean): void {
    this.statusListeners.forEach((fn) => fn(connected));
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  onHealth(fn: HealthListener): () => void {
    this.healthListeners.add(fn);
    return () => this.healthListeners.delete(fn);
  }

  onActivity(fn: ActivityListener): () => void {
    this.activityListeners.add(fn);
    return () => this.activityListeners.delete(fn);
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
}

// Singleton — one connection for the whole app
export const bossWs = new BossWebSocket();
