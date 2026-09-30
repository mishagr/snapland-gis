import { describe, expect, it } from 'vitest';
import { PasswordHasher } from '@/server/auth/PasswordHasher';

const fast = new PasswordHasher({ N: 1024, r: 8, p: 1, keyLength: 32 });

describe('PasswordHasher', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await fast.hash('correct horse');
    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(await fast.verify('correct horse', hash)).toBe(true);
    expect(await fast.verify('battery staple', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await fast.hash('same')).not.toBe(await fast.hash('same'));
  });

  it('rejects malformed encodings and flags outdated parameters', async () => {
    expect(await fast.verify('x', 'bcrypt$whatever')).toBe(false);
    const hash = await fast.hash('pw');
    expect(new PasswordHasher({ N: 2048, r: 8, p: 1, keyLength: 32 }).needsRehash(hash)).toBe(true);
    expect(fast.needsRehash(hash)).toBe(false);
  });
});
