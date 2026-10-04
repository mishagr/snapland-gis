import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, type ConnectionStatus } from '@/lib/realtime/RealtimeClient';

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

describe('RealtimeClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = () =>
    new RealtimeClient({ url: 'ws://test/ws', WebSocketImpl: FakeSocket as unknown as typeof WebSocket, baseDelayMs: 100, heartbeatMs: 1000, pongTimeoutMs: 500 });

  it('re-sends the viewport after reconnecting and signals `reconnected`', () => {
    const client = make();
    const statuses: ConnectionStatus[] = [];
    const reconnected = vi.fn();
    client.on('status', (s) => statuses.push(s));
    client.on('reconnected', reconnected);
    client.connect();
    FakeSocket.instances[0]!.open();
    client.setViewport({ minLng: 1, minLat: 1, maxLng: 2, maxLat: 2 });
    FakeSocket.instances[0]!.close(1006);
    vi.advanceTimersByTime(1000);
    const second = FakeSocket.instances[1]!;
    second.open();
    expect(second.sent[0]).toMatchObject({ type: 'viewport' });
    expect(reconnected).toHaveBeenCalledOnce();
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting', 'open']);
  });

  it('stops reconnecting when the session expired', () => {
    const client = make();
    client.connect();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.close(4001);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(client.status).toBe('unauthorized');
  });

  it('throttles sketch updates and rounds coordinates', () => {
    const client = make();
    client.connect();
    const ws = FakeSocket.instances[0]!;
    ws.open();
    for (let i = 0; i < 10; i++) client.sendSketch([[34.123456789, 32.1 + i / 1000]], 0);
    vi.advanceTimersByTime(150);
    const sketches = ws.sent.filter((m) => (m as { type: string }).type === 'sketch') as { points: number[][] }[];
    expect(sketches).toHaveLength(2); // leading + trailing
    expect(sketches[1]!.points[0]![0]).toBe(34.123457);
    expect(sketches[1]!.points[0]![1]).toBeCloseTo(32.109, 6);
  });

  it('closes a half-open connection when pongs stop arriving', () => {
    const client = make();
    client.connect();
    const ws = FakeSocket.instances[0]!;
    ws.open();
    vi.advanceTimersByTime(1000); // ping sent
    expect(ws.sent.some((m) => (m as { type: string }).type === 'ping')).toBe(true);
    vi.advanceTimersByTime(600); // no pong → close → reconnect scheduled
    expect(client.status).toBe('reconnecting');
  });
});
