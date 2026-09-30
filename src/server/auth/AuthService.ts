import type { PrismaClient } from '@/generated/prisma/client';
import type { LoginInput, RegisterInput } from '@/lib/api/schemas';
import type { UserDto } from '@/lib/api/types';
import { ApiError } from '@/server/http/errors';
import type { PasswordHasher } from './PasswordHasher';

/** Registration and credential checks. Sessions are handled by SessionStore. */
export class AuthService {
  /** Verified against when the email is unknown, so both paths cost the same. */
  private dummyHashPromise: Promise<string> | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly hasher: PasswordHasher,
  ) {}

  async register(input: RegisterInput): Promise<UserDto> {
    const passwordHash = await this.hasher.hash(input.password);
    try {
      const user = await this.prisma.user.create({
        data: { email: input.email, displayName: input.displayName, passwordHash },
        select: { id: true, email: true, displayName: true },
      });
      return user;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
      }
      throw err;
    }
  }

  /** Returns the user for valid credentials, or null. Timing does not reveal whether the email exists. */
  async verifyCredentials(input: LoginInput): Promise<UserDto | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, email: true, displayName: true, passwordHash: true },
    });
    if (!user) {
      this.dummyHashPromise ??= this.hasher.hash('timing-equaliser');
      await this.hasher.verify(input.password, await this.dummyHashPromise);
      return null;
    }
    const ok = await this.hasher.verify(input.password, user.passwordHash);
    if (!ok) return null;
    if (this.hasher.needsRehash(user.passwordHash)) {
      const passwordHash = await this.hasher.hash(input.password);
      await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    }
    return { id: user.id, email: user.email, displayName: user.displayName };
  }

  async findById(id: string): Promise<UserDto | null> {
    return this.prisma.user.findUnique({ where: { id }, select: { id: true, email: true, displayName: true } });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
