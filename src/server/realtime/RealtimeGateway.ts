import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { BBoxUtil } from '@/lib/geo/BBoxUtil';
import type { BBox } from '@/lib/geo/types';
import {
  CloseCode,
  clientMessageSchema,
  PROTOCOL_VERSION,
  WS_MAX_PAYLOAD,
  WS_PATH,
  type AreaEvent,
  type ClientMessage,
  type PresenceUser,
  type ServerMessage,
} from '@/lib/realtime/protocol';
import type { AuditLogger } from '@/server/audit/AuditLogger';
import { readCookie, SESSION_COOKIE } from '@/server/auth/cookies';
import type { Session, SessionStore } from '@/server/auth/SessionStore';
import { isAllowedOrigin } from '@/server/security/origin';
import { TokenBucket } from '@/server/security/RateLimiter';
import type { AreaDomainEvent, DomainEventBus } from './EventBus';
import { PresenceRegistry, type PresenceChange } from './PresenceRegistry';
import type { RealtimeStats } from './stats';

export interface RealtimeGatewayOptions {
  sessions: SessionStore;
  bus: DomainEventBus;
  audit: AuditLogger;
  logger: Logger;
  maxConnectionsPerUser: number;
  heartbeatMs?: number;
  /** Re-validate the session every N heartbeats (logout / expiry closes sockets). */
  sessionCheckEvery?: number;
  /** Stop sending to a socket whose unsent buffer exceeds this many bytes. */
  maxBufferedBytes?: number;
  clientIp?: (req: IncomingMessage) => string | undefined;
}

interface Client {
  id: string;
  ws: WebSocket;
  session: Session;
  viewport: BBox | null;
  alive: boolean;
  heartbeats: number;
  bucket: TokenBucket;
  sketching: boolean;
  /** Messages were dropped for backpressure; send `resync` once the buffer drains. */
  needsResync: boolean;
}

const AREA_EVENT: Record<AreaDomainEvent['type'], AreaEvent> = {
  'area.created': 'created',
  'area.updated': 'updated',
  'area.deleted': 'deleted',
  'area.restored': 'restored',
};

/**
 * WebSocket endpoint for live collaboration.
 *
 * Security: the upgrade is authenticated with the same httpOnly session cookie as
 * the REST API and the Origin header must be allow-listed (prevents cross-site
 * WebSocket hijacking). Per-user connection caps, a per-socket token bucket and a
 * max frame size bound resource use; sessions are re-checked periodically.
 *
 * Efficiency: every client reports its viewport; area and sketch events are only
 * sent to clients whose viewport intersects the geometry. Slow consumers are
 * detected via `bufferedAmount` and told to resync instead of queueing unbounded.
 */
export class RealtimeGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false });
  private readonly clients = new Map<string, Client>();
  private readonly presence = new PresenceRegistry();
  private readonly unsubscribe: () => void;
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly stats = { messagesIn: 0, messagesOut: 0, droppedForBackpressure: 0, rejectedUpgrades: 0 };
  private readonly opts: Required<Omit<RealtimeGatewayOptions, 'clientIp'>> & Pick<RealtimeGatewayOptions, 'clientIp'>;

  constructor(options: RealtimeGatewayOptions) {
    this.opts = { heartbeatMs: 30_000, sessionCheckEvery: 4, maxBufferedBytes: 1024 * 1024, ...options };
    this.unsubscribe = this.opts.bus.subscribe((event) => this.onDomainEvent(event));
    this.heartbeat = setInterval(() => void this.tick(), this.opts.heartbeatMs);
    this.heartbeat.unref();
  }

  /** `upgrade` listener for the HTTP server. Returns false for paths it does not own (e.g. Next HMR). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = (req.url ?? '').split('?')[0];
    if (path !== WS_PATH) return false;
    void this.authorizeAndUpgrade(req, socket, head);
    return true;
  }

  getStats(): RealtimeStats {
    return { connections: this.clients.size, users: this.presence.size, ...this.stats };
  }

  /** Graceful shutdown: tell clients to reconnect (to another instance) and stop timers. */
  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    this.unsubscribe();
    for (const client of this.clients.values()) client.ws.close(CloseCode.GOING_AWAY, 'Server restarting');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private async authorizeAndUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const reject = (status: number, reason: string) => {
      this.stats.rejectedUpgrades++;
      this.opts.audit.record({
        action: 'ws.rejected',
        entityType: 'socket',
        metadata: { status, reason },
        ip: this.opts.clientIp?.(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    try {
      if (!isAllowedOrigin(req.headers.origin)) return reject(403, 'Forbidden');
      const session = await this.opts.sessions.get(readCookie(req.headers.cookie, SESSION_COOKIE));
      if (!session) return reject(401, 'Unauthorized');
      if (this.presence.connectionCount(session.userId) >= this.opts.maxConnectionsPerUser) {
        return reject(429, 'Too Many Requests');
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, session, req));
    } catch (err) {
      this.opts.logger.error({ err }, 'websocket upgrade failed');
      reject(503, 'Service Unavailable');
    }
  }

  private onConnection(ws: WebSocket, session: Session, req: IncomingMessage): void {
    const client: Client = {
      id: randomUUID(),
      ws,
      session,
      viewport: null,
      alive: true,
      heartbeats: 0,
      // Bursts of 40 messages, sustained 20/s: enough for smooth sketch streaming.
      bucket: new TokenBucket(40, 20),
      sketching: false,
      needsResync: false,
    };
    this.clients.set(client.id, client);
    const change = this.presence.add(session.userId, session.displayName, client.id);
    this.opts.audit.record({
      action: 'ws.connect',
      userId: session.userId,
      entityType: 'socket',
      entityId: client.id,
      ip: this.opts.clientIp?.(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    this.send(client, {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      you: this.presence.get(session.userId)!,
      users: this.presence.list(),
      serverTime: Date.now(),
    });
    this.broadcastPresence(change, client.id);

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => this.onMessage(client, data, isBinary));
    ws.on('close', () => this.onClose(client));
    ws.on('error', (err) => this.opts.logger.warn({ err, socket: client.id }, 'websocket error'));
  }

  private onMessage(client: Client, data: RawData, isBinary: boolean): void {
    this.stats.messagesIn++;
    if (!client.bucket.take()) {
      this.send(client, { type: 'error', code: 'RATE_LIMITED', message: 'Slow down' });
      return;
    }
    let message: ClientMessage;
    try {
      if (isBinary) throw new Error('binary frames are not supported');
      const parsed = clientMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid message');
      message = parsed.data;
    } catch (err) {
      this.send(client, { type: 'error', code: 'BAD_MESSAGE', message: err instanceof Error ? err.message : 'invalid message' });
      return;
    }

    const { userId, displayName } = client.session;
    switch (message.type) {
      case 'viewport':
        client.viewport = message.bbox;
        break;
      case 'sketch': {
        const wasSketching = client.sketching;
        client.sketching = true;
        if (!wasSketching) this.broadcastPresence(this.presence.setDrawing(userId, client.id, true));
        if (message.points.length === 0) break;
        const bbox = BBoxUtil.fromPositions(message.points);
        const color = this.presence.get(userId)?.color ?? '#333';
        this.broadcast(
          { type: 'sketch', userId, displayName, color, points: message.points, areaSqKm: message.areaSqKm },
          (c) => c.id !== client.id && this.sees(c, bbox),
        );
        break;
      }
      case 'sketch:end':
        this.endSketch(client);
        break;
      case 'editing':
        this.broadcastPresence(this.presence.setEditing(userId, message.areaId));
        break;
      case 'ping':
        this.send(client, { type: 'pong', t: message.t, serverTime: Date.now() });
        break;
    }
  }

  private onClose(client: Client): void {
    if (!this.clients.delete(client.id)) return;
    if (client.sketching) this.broadcast({ type: 'sketch:end', userId: client.session.userId }, (c) => c.id !== client.id);
    this.broadcastPresence(this.presence.remove(client.session.userId, client.id));
  }

  private endSketch(client: Client): void {
    if (!client.sketching) return;
    client.sketching = false;
    const { userId } = client.session;
    this.broadcast({ type: 'sketch:end', userId }, (c) => c.id !== client.id);
    this.broadcastPresence(this.presence.setDrawing(userId, client.id, false));
  }

  private onDomainEvent(event: AreaDomainEvent): void {
    const bbox = BBoxUtil.fromPositions(event.area.geometry.coordinates[0]);
    const message: ServerMessage = { type: 'area', event: AREA_EVENT[event.type], area: event.area, actor: event.actor };
    this.broadcast(
      message,
      // The author also receives it: other tabs of the same user must update too.
      (c) => this.sees(c, bbox) || (event.previousBBox !== undefined && this.sees(c, event.previousBBox)),
    );
  }

  /** Clients that have not reported a viewport yet get nothing; they fetch on their first viewport. */
  private sees(client: Client, bbox: BBox): boolean {
    return client.viewport !== null && BBoxUtil.intersects(client.viewport, bbox);
  }

  private broadcastPresence(change: PresenceChange, exceptClientId?: string): void {
    if (!change) return;
    this.broadcast({ type: 'presence', event: change.event, user: change.user }, (c) => c.id !== exceptClientId);
  }

  private broadcast(message: ServerMessage, filter: (client: Client) => boolean): void {
    // Serialise once, not per recipient.
    const payload = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (filter(client)) this.sendRaw(client, payload);
    }
  }

  private send(client: Client, message: ServerMessage): void {
    this.sendRaw(client, JSON.stringify(message));
  }

  private sendRaw(client: Client, payload: string): void {
    const { ws } = client;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > this.opts.maxBufferedBytes) {
      this.stats.droppedForBackpressure++;
      client.needsResync = true;
      return;
    }
    if (client.needsResync) {
      client.needsResync = false;
      ws.send(JSON.stringify({ type: 'resync', reason: 'messages were dropped' } satisfies ServerMessage));
    }
    this.stats.messagesOut++;
    ws.send(payload);
  }

  /** Ping/pong liveness + periodic session re-validation. */
  private async tick(): Promise<void> {
    for (const client of this.clients.values()) {
      if (!client.alive) {
        client.ws.terminate();
        this.onClose(client);
        continue;
      }
      client.alive = false;
      client.ws.ping();
      client.heartbeats++;
      if (client.heartbeats % this.opts.sessionCheckEvery === 0) {
        try {
          const session = await this.opts.sessions.get(client.session.id);
          if (!session) client.ws.close(CloseCode.SESSION_EXPIRED, 'Session expired');
        } catch {
          // Redis hiccup: keep the socket; the next check will retry.
        }
      }
    }
  }

  /** Test hook. */
  presenceList(): PresenceUser[] {
    return this.presence.list();
  }
}
