import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the next action would be allowed (0 when allowed). */
  retryAfterMs: number;
}

export interface RateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  consume(key: string): Promise<RateLimitResult>;
}

export interface RateLimiterOptions {
  /** Namespace for keys, e.g. `draw`. */
  name: string;
  limit: number;
  windowMs: number;
}

/**
 * Sliding-window log in a Redis sorted set, evaluated atomically in Lua using the
 * Redis clock (so multiple app instances agree on time). Precise: "50 per minute"
 * means at most 50 in *any* 60 s window, not per calendar minute.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry = window - (now - tonumber(oldest[2]))
if retry < 1 then retry = 1 end
return {0, 0, retry}
`;

type RedisWithLimiter = Redis & {
  slidingWindowConsume(key: string, windowMs: number, limit: number, member: string): Promise<[number, number, number]>;
};

export class RedisSlidingWindowRateLimiter implements RateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly name: string;

  constructor(
    private readonly redis: Redis,
    options: RateLimiterOptions,
    private readonly onError: (err: unknown) => void = () => {},
  ) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.name = options.name;
    if (!('slidingWindowConsume' in redis)) {
      redis.defineCommand('slidingWindowConsume', { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });
    }
  }

  async consume(key: string): Promise<RateLimitResult> {
    try {
      const member = `${Date.now()}-${randomBytes(4).toString('hex')}`;
      const [allowed, remaining, retryAfterMs] = await (this.redis as RedisWithLimiter).slidingWindowConsume(
        `rl:${this.name}:${key}`,
        this.windowMs,
        this.limit,
        member,
      );
      return { allowed: allowed === 1, limit: this.limit, remaining, retryAfterMs };
    } catch (err) {
      // Fail open: an outage of the limiter must not take drawing down with it.
      this.onError(err);
      return { allowed: true, limit: this.limit, remaining: this.limit, retryAfterMs: 0 };
    }
  }
}

/** Same algorithm in process memory: used for unit tests and per-socket WS limits. */
export class InMemorySlidingWindowRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async consume(key: string): Promise<RateLimitResult> {
    return this.consumeSync(key);
  }

  consumeSync(key: string): RateLimitResult {
    const now = this.now();
    const log = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (log.length < this.limit) {
      log.push(now);
      this.hits.set(key, log);
      return { allowed: true, limit: this.limit, remaining: this.limit - log.length, retryAfterMs: 0 };
    }
    this.hits.set(key, log);
    return { allowed: false, limit: this.limit, remaining: 0, retryAfterMs: Math.max(1, log[0]! + this.windowMs - now) };
  }

  reset(key?: string): void {
    if (key) this.hits.delete(key);
    else this.hits.clear();
  }
}

/** Token bucket for high-frequency streams (WS sketch updates): smooth rate with bursts. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(cost = 1): boolean {
    const now = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSecond);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}
