import { describe, expect, it } from 'vitest';
import { InMemorySlidingWindowRateLimiter, TokenBucket } from '@/server/security/RateLimiter';

describe('InMemorySlidingWindowRateLimiter', () => {
  it('allows 50 drawing actions per minute and rejects the 51st with a retry hint', async () => {
    let now = 0;
    const limiter = new InMemorySlidingWindowRateLimiter(50, 60_000, () => now);
    for (let i = 0; i < 50; i++) {
      now += 100;
      expect((await limiter.consume('u1')).allowed).toBe(true);
    }
    const denied = await limiter.consume('u1');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(100 + 60_000 - now);
  });

  it('slides: capacity returns as old actions leave the window', () => {
    let now = 0;
    const limiter = new InMemorySlidingWindowRateLimiter(2, 1000, () => now);
    expect(limiter.consumeSync('k').allowed).toBe(true);
    now = 500;
    expect(limiter.consumeSync('k').allowed).toBe(true);
    now = 900;
    expect(limiter.consumeSync('k').allowed).toBe(false);
    now = 1001;
    expect(limiter.consumeSync('k').allowed).toBe(true);
  });

  it('keeps keys independent', () => {
    const limiter = new InMemorySlidingWindowRateLimiter(1, 1000);
    expect(limiter.consumeSync('a').allowed).toBe(true);
    expect(limiter.consumeSync('b').allowed).toBe(true);
    expect(limiter.consumeSync('a').allowed).toBe(false);
  });
});

describe('TokenBucket', () => {
  it('allows bursts up to capacity then refills at the configured rate', () => {
    let now = 0;
    const bucket = new TokenBucket(3, 10, () => now);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
    now = 100; // +1 token
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });
});
