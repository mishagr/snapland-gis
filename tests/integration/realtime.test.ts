import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerMessage } from '@/lib/realtime/protocol';
import { RealtimeGateway } from '@/server/realtime/RealtimeGateway';
import { bootServices, integrationEnabled, makeUser, resetData, shutdown, square } from './helpers';

type Services = Awaited<ReturnType<typeof bootServices>>;

class TestClient {
  readonly messages: ServerMessage[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.messages.push(JSON.parse(d.toString()) as ServerMessage));
  }
  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }
  async waitFor(pred: (m: ServerMessage) => boolean, ms = 2000): Promise<ServerMessage> {
    const start = Date.now();
    for (;;) {
      const found = this.messages.find(pred);
      if (found) return found;
      if (Date.now() - start > ms) throw new Error('timed out waiting for message');
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

describe.skipIf(!integrationEnabled)('RealtimeGateway', () => {
  let s: Services;
  let server: Server;
  let gateway: RealtimeGateway;
  let url: string;

  beforeAll(async () => {
    s = await bootServices();
    gateway = new RealtimeGateway({ sessions: s.sessions, bus: s.bus, audit: s.audit, logger: s.logger, maxConnectionsPerUser: 3 });
    server = createServer((_req, res) => res.end());
    server.on('upgrade', (req, socket, head) => {
      if (!gateway.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  });
  beforeEach(async () => resetData(s));
  afterAll(async () => {
    await gateway.close();
    server.close();
    await shutdown(s);
  });

  async function connect(userId: string, name: string, origin = 'http://localhost:3000'): Promise<TestClient> {
    const session = await s.sessions.create({ userId, email: `${name}@x`, displayName: name });
    const ws = new WebSocket(url, { headers: { cookie: `snapland_sid=${session.id}`, origin } });
    const client = new TestClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    await client.waitFor((m) => m.type === 'hello');
    return client;
  }

  const view = (minLng: number, minLat: number, maxLng: number, maxLat: number) => ({ type: 'viewport', bbox: { minLng, minLat, maxLng, maxLat } });

  it('rejects upgrades without a valid session or from foreign origins', async () => {
    const tryOpen = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(url, { headers });
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('open', () => resolve(101));
        ws.on('error', () => undefined);
      });
    expect(await tryOpen({ origin: 'http://localhost:3000' })).toBe(401);
    expect(await tryOpen({ cookie: 'snapland_sid=' + 'x'.repeat(43), origin: 'http://localhost:3000' })).toBe(401);
    const session = await s.sessions.create({ userId: 'u', email: 'e', displayName: 'E' });
    expect(await tryOpen({ cookie: `snapland_sid=${session.id}`, origin: 'https://evil.example' })).toBe(403);
  });

  it('delivers area events only to clients whose viewport intersects the area', async () => {
    const alice = await makeUser(s, 'Alice');
    const bob = await makeUser(s, 'Bob');
    const carol = await makeUser(s, 'Carol');
    const a = await connect(alice.id, 'Alice');
    const b = await connect(bob.id, 'Bob');
    const c = await connect(carol.id, 'Carol');
    a.send(view(34.7, 32.0, 34.9, 32.2));
    b.send(view(34.7, 32.0, 34.9, 32.2));
    c.send(view(35.1, 32.7, 35.2, 32.8)); // Haifa: elsewhere
    await new Promise((r) => setTimeout(r, 50));
    const area = await s.areas.create(alice, { name: 'Tel Aviv park', description: '', geometry: square(34.78, 32.08) }, { requestId: 'x' });
    const event = await b.waitFor((m) => m.type === 'area');
    expect(event).toMatchObject({ type: 'area', event: 'created', area: { id: area.id }, actor: { id: alice.id } });
    await a.waitFor((m) => m.type === 'area'); // the author's other tabs need it too
    await new Promise((r) => setTimeout(r, 100));
    expect(c.messages.some((m) => m.type === 'area')).toBe(false);

    // Moving the area into Carol's view notifies her; the old viewers learn it moved away.
    await s.areas.update(bob, area.id, { expectedVersion: 1, geometry: square(35.15, 32.75) }, { requestId: 'y' });
    await c.waitFor((m) => m.type === 'area' && m.event === 'updated');
    await a.waitFor((m) => m.type === 'area' && m.event === 'updated');
    for (const x of [a, b, c]) x.ws.close();
  });

  it('relays live sketches to overlapping viewers, never back to the sender', async () => {
    const alice = await makeUser(s, 'Alice');
    const bob = await makeUser(s, 'Bob');
    const a = await connect(alice.id, 'Alice');
    const b = await connect(bob.id, 'Bob');
    b.send(view(34.7, 32.0, 34.9, 32.2));
    await new Promise((r) => setTimeout(r, 50));
    a.send({ type: 'sketch', points: [[34.78, 32.08], [34.79, 32.08], [34.79, 32.09]], areaSqKm: 0.5 });
    const sketch = await b.waitFor((m) => m.type === 'sketch');
    // Identity comes from the session, not the message.
    expect(sketch).toMatchObject({ userId: alice.id, displayName: 'Alice', areaSqKm: 0.5 });
    await b.waitFor((m) => m.type === 'presence' && m.user.userId === alice.id && m.user.drawing);
    a.send({ type: 'sketch:end' });
    await b.waitFor((m) => m.type === 'sketch:end');
    expect(a.messages.some((m) => m.type === 'sketch')).toBe(false);
    a.ws.close();
    await b.waitFor((m) => m.type === 'presence' && m.event === 'leave');
    b.ws.close();
  });

  it('reports presence joins, multi-tab updates and leaves', async () => {
    const alice = await makeUser(s, 'Alice');
    const bob = await makeUser(s, 'Bob');
    const a = await connect(alice.id, 'Alice');
    const b1 = await connect(bob.id, 'Bob');
    await a.waitFor((m) => m.type === 'presence' && m.event === 'join' && m.user.userId === bob.id);
    const b2 = await connect(bob.id, 'Bob');
    await a.waitFor((m) => m.type === 'presence' && m.event === 'update' && m.user.connections === 2);
    b1.ws.close();
    b2.ws.close();
    await a.waitFor((m) => m.type === 'presence' && m.event === 'leave' && m.user.userId === bob.id);
    expect(gateway.presenceList().map((u) => u.displayName)).toEqual(['Alice']);
    a.ws.close();
  });

  it('answers malformed messages with an error and caps connections per user', async () => {
    const alice = await makeUser(s, 'Alice');
    const a = await connect(alice.id, 'Alice');
    a.ws.send('not json');
    a.send({ type: 'sketch', points: [[999, 0]], areaSqKm: 0 });
    const errors = [await a.waitFor((m) => m.type === 'error')];
    expect(errors[0]).toMatchObject({ code: 'BAD_MESSAGE' });
    const extra = [await connect(alice.id, 'Alice'), await connect(alice.id, 'Alice')];
    await expect(connect(alice.id, 'Alice')).rejects.toThrow('HTTP 429');
    for (const x of [a, ...extra]) x.ws.close();
  });

  it('answers pings (used by clients to detect half-open connections)', async () => {
    const alice = await makeUser(s, 'Alice');
    const a = await connect(alice.id, 'Alice');
    a.send({ type: 'ping', t: 42 });
    expect(await a.waitFor((m) => m.type === 'pong')).toMatchObject({ t: 42 });
    a.ws.close();
  });
});
