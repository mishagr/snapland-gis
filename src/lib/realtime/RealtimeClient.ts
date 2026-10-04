import type { BBox, LngLat } from '@/lib/geo/types';
import { Emitter } from '@/lib/util/Emitter';
import { CloseCode, WS_PATH, type ClientMessage, type ServerMessage } from './protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'offline' | 'unauthorized';

type RealtimeEvents = {
  status: (status: ConnectionStatus) => void;
  message: (message: ServerMessage) => void;
  /** Fired after a reconnect (not the first connect): the client should refetch state it may have missed. */
  reconnected: () => void;
};

export interface RealtimeClientOptions {
  url?: string;
  /** Injected for tests. */
  WebSocketImpl?: typeof WebSocket;
  baseDelayMs?: number;
  maxDelayMs?: number;
  heartbeatMs?: number;
  pongTimeoutMs?: number;
  sketchThrottleMs?: number;
}

/**
 * Browser WebSocket client with the resilience the UI relies on:
 * - exponential backoff with full jitter on reconnect (no thundering herd after a deploy);
 * - app-level ping/pong to detect half-open connections the browser cannot see;
 * - state that must survive reconnects (viewport, editing hint) is re-sent on open;
 * - sketch updates are throttled and coordinates rounded (≈10 cm) to keep frames small.
 */
export class RealtimeClient extends Emitter<RealtimeEvents> {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private everOpened = false;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pongDeadline: ReturnType<typeof setTimeout> | undefined;
  private viewport: BBox | null = null;
  private editingAreaId: string | null = null;
  private pendingSketch: { points: LngLat[]; areaSqKm: number } | null = null;
  private sketchTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSketchSent = 0;
  private _status: ConnectionStatus = 'offline';
  private _rttMs: number | null = null;
  private readonly opts: Required<Omit<RealtimeClientOptions, 'url' | 'WebSocketImpl'>> & Pick<RealtimeClientOptions, 'url' | 'WebSocketImpl'>;

  constructor(options: RealtimeClientOptions = {}) {
    super();
    this.opts = { baseDelayMs: 500, maxDelayMs: 15_000, heartbeatMs: 20_000, pongTimeoutMs: 8_000, sketchThrottleMs: 100, ...options };
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  get rttMs(): number | null {
    return this._rttMs;
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  disconnect(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.ws?.close(CloseCode.NORMAL, 'client closed');
    this.ws = null;
    this.setStatus('offline');
  }

  setViewport(bbox: BBox): void {
    this.viewport = bbox;
    this.send({ type: 'viewport', bbox });
  }

  setEditing(areaId: string | null): void {
    this.editingAreaId = areaId;
    this.send({ type: 'editing', areaId });
  }

  /** Throttled (leading + trailing) so fast mouse movement never floods the socket. */
  sendSketch(points: LngLat[], areaSqKm: number): void {
    this.pendingSketch = { points: points.map(([lng, lat]) => [round6(lng), round6(lat)]), areaSqKm };
    const wait = this.opts.sketchThrottleMs - (Date.now() - this.lastSketchSent);
    if (wait <= 0) {
      this.flushSketch();
    } else if (!this.sketchTimer) {
      this.sketchTimer = setTimeout(() => this.flushSketch(), wait);
    }
  }

  endSketch(): void {
    clearTimeout(this.sketchTimer);
    this.sketchTimer = undefined;
    this.pendingSketch = null;
    this.send({ type: 'sketch:end' });
  }

  private flushSketch(): void {
    clearTimeout(this.sketchTimer);
    this.sketchTimer = undefined;
    if (!this.pendingSketch) return;
    this.lastSketchSent = Date.now();
    this.send({ type: 'sketch', ...this.pendingSketch });
    this.pendingSketch = null;
  }

  private open(): void {
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const url = this.opts.url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;
    this.setStatus(this.everOpened ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new Impl(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      const isReconnect = this.everOpened;
      this.everOpened = true;
      this.attempts = 0;
      this.setStatus('open');
      if (this.viewport) this.send({ type: 'viewport', bbox: this.viewport });
      if (this.editingAreaId) this.send({ type: 'editing', areaId: this.editingAreaId });
      this.startHeartbeat();
      if (isReconnect) this.emit('reconnected');
    };
    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'pong') {
        clearTimeout(this.pongDeadline);
        this._rttMs = Date.now() - message.t;
      }
      this.emit('message', message);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      if (this.stopped) return;
      if (event.code === CloseCode.SESSION_EXPIRED) {
        this.stopped = true;
        this.setStatus('unauthorized');
        return;
      }
      this.scheduleReconnect(event.code === CloseCode.TOO_MANY_CONNECTIONS ? 4 : 1);
    };
    ws.onerror = () => {
      // onclose follows; nothing else to do here.
    };
  }

  private scheduleReconnect(multiplier = 1): void {
    this.setStatus(this.everOpened ? 'reconnecting' : 'offline');
    const cap = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** this.attempts) * multiplier;
    this.attempts = Math.min(this.attempts + 1, 10);
    // Full jitter: uniformly random in [0, cap].
    const delay = Math.random() * cap;
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.send({ type: 'ping', t: Date.now() })) return;
      clearTimeout(this.pongDeadline);
      this.pongDeadline = setTimeout(() => {
        // No pong: the connection is dead even if the browser has not noticed.
        this.ws?.close();
      }, this.opts.pongTimeoutMs);
    }, this.opts.heartbeatMs);
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.pongDeadline);
  }

  private send(message: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit('status', status);
  }
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
