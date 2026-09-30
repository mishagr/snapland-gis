import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface SessionData {
  userId: string;
  email: string;
  displayName: string;
  createdAt: number;
  ip?: string;
}

export interface Session extends SessionData {
  id: string;
}

/**
 * Server-side sessions in Redis. The browser only holds an opaque 256-bit id in an
 * httpOnly cookie; revocation is immediate (delete the key) and the TTL slides on
 * every authenticated request. A per-user index allows "log out everywhere".
 */
export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  async create(data: Omit<SessionData, 'createdAt'>): Promise<Session> {
    const id = randomBytes(32).toString('base64url');
    const session: SessionData = { ...data, createdAt: Date.now() };
    await this.redis
      .multi()
      .set(this.key(id), JSON.stringify(session), 'EX', this.ttlSeconds)
      .sadd(this.userKey(data.userId), id)
      .expire(this.userKey(data.userId), this.ttlSeconds)
      .exec();
    return { id, ...session };
  }

  /** Returns the session and refreshes its TTL (sliding expiry) in one round trip. */
  async get(id: string | undefined | null): Promise<Session | null> {
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const raw = await this.redis.getex(this.key(id), 'EX', this.ttlSeconds);
    if (!raw) return null;
    try {
      return { id, ...(JSON.parse(raw) as SessionData) };
    } catch {
      return null;
    }
  }

  async destroy(id: string): Promise<void> {
    const raw = await this.redis.get(this.key(id));
    const multi = this.redis.multi().del(this.key(id));
    if (raw) multi.srem(this.userKey((JSON.parse(raw) as SessionData).userId), id);
    await multi.exec();
  }

  async destroyAllForUser(userId: string): Promise<number> {
    const ids = await this.redis.smembers(this.userKey(userId));
    if (ids.length === 0) return 0;
    await this.redis.del(...ids.map((id) => this.key(id)), this.userKey(userId));
    return ids.length;
  }

  private key(id: string): string {
    return `sess:${id}`;
  }

  private userKey(userId: string): string {
    return `user-sess:${userId}`;
  }
}
