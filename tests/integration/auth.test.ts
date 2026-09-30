import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@/server/http/errors';
import { RedisSlidingWindowRateLimiter } from '@/server/security/RateLimiter';
import { bootServices, integrationEnabled, resetData, shutdown } from './helpers';

type Services = Awaited<ReturnType<typeof bootServices>>;

describe.skipIf(!integrationEnabled)('auth, sessions and Redis rate limiting', () => {
  let s: Services;
  beforeAll(async () => {
    s = await bootServices();
  });
  beforeEach(async () => resetData(s));
  afterAll(async () => shutdown(s));

  it('registers (emails are unique, case-insensitively) and verifies credentials', async () => {
    const user = await s.auth.register({ email: 'carol@test.local', password: 'password123', displayName: 'Carol' });
    const dup = (await s.auth.register({ email: 'carol@test.local', password: 'x'.repeat(8), displayName: 'C2' }).catch((e) => e)) as ApiError;
    expect(dup.code).toBe('EMAIL_TAKEN');
    expect(await s.auth.verifyCredentials({ email: 'carol@test.local', password: 'password123' })).toEqual(user);
    expect(await s.auth.verifyCredentials({ email: 'carol@test.local', password: 'wrong-pass' })).toBeNull();
    expect(await s.auth.verifyCredentials({ email: 'nobody@test.local', password: 'password123' })).toBeNull();
    const row = await s.prisma.user.findUnique({ where: { id: user.id } });
    expect(row!.passwordHash).toMatch(/^scrypt\$/);
  });

  it('stores sessions in Redis with sliding expiry and supports revocation', async () => {
    const session = await s.sessions.create({ userId: '00000000-0000-0000-0000-000000000001', email: 'e', displayName: 'E' });
    expect(session.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await s.redis.expire(`sess:${session.id}`, 10);
    expect((await s.sessions.get(session.id))?.userId).toBe('00000000-0000-0000-0000-000000000001');
    expect(await s.redis.ttl(`sess:${session.id}`)).toBeGreaterThan(10); // refreshed
    expect(await s.sessions.get('not-a-session')).toBeNull();
    await s.sessions.create({ userId: '00000000-0000-0000-0000-000000000001', email: 'e', displayName: 'E' });
    expect(await s.sessions.destroyAllForUser('00000000-0000-0000-0000-000000000001')).toBe(2);
    expect(await s.sessions.get(session.id)).toBeNull();
  });

  it('Redis sliding window: 50 per minute, atomic under concurrency', async () => {
    const limiter = new RedisSlidingWindowRateLimiter(s.redis, { name: 'itest', limit: 50, windowMs: 60_000 });
    const results = await Promise.all(Array.from({ length: 60 }, () => limiter.consume('user-1')));
    expect(results.filter((r) => r.allowed)).toHaveLength(50);
    const denied = results.find((r) => !r.allowed)!;
    expect(denied.retryAfterMs).toBeGreaterThan(59_000);
    expect((await limiter.consume('user-2')).allowed).toBe(true);
  });

  it('fails open when Redis is unreachable', async () => {
    const { Redis } = await import('ioredis');
    const dead = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
    let reported = false;
    const limiter = new RedisSlidingWindowRateLimiter(dead, { name: 'dead', limit: 1, windowMs: 1000 }, () => (reported = true));
    expect((await limiter.consume('k')).allowed).toBe(true);
    expect(reported).toBe(true);
    dead.disconnect();
  });
});
