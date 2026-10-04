import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

const DEFAULT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1, keyLength: 64 };

/**
 * Password hashing with Node's built-in scrypt (memory-hard, no native addon).
 * Format: `scrypt$N$r$p$<salt b64>$<hash b64>` so parameters can be raised later
 * without invalidating existing hashes (`needsRehash`).
 */
export class PasswordHasher {
  constructor(private readonly params: ScryptParams = DEFAULT_PARAMS) {}

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const { N, r, p, keyLength } = this.params;
    const key = await scrypt(password, salt, keyLength, { N, r, p, maxmem: 256 * N * r });
    return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
    const expected = Buffer.from(hashB64, 'base64');
    const N = Number(n), R = Number(r), P = Number(p);
    if (!Number.isInteger(N) || !Number.isInteger(R) || !Number.isInteger(P) || expected.length === 0) return false;
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N, r: R, p: P, maxmem: 256 * N * R });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  needsRehash(encoded: string): boolean {
    const [, n, r, p] = encoded.split('$');
    return Number(n) !== this.params.N || Number(r) !== this.params.r || Number(p) !== this.params.p;
  }
}
