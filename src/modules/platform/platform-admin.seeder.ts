/**
 * Seed logic for platform operators (the Salesbox team).
 *
 * Kept as a pure function over a narrow dependency slice (not the whole
 * PrismaClient) so the identity-separation rule is unit-testable without a
 * database. The runnable entry point is `scripts/seed-platform-admin.ts`.
 *
 * Rule enforced here: an email that already belongs to a tenant user
 * (`ConnectedAccount`) can never become a platform admin — platform operators
 * are a separate identity domain (separation of duties), per the platform-admin
 * console spec §3.1.
 */

export interface SeedPlatformAdminInput {
  email: string;
  passwordHash: string;
  name?: string;
}

export interface SeededPlatformAdmin {
  id: string;
  email: string;
  name: string | null;
}

/** The slice of Prisma the seeder needs. The real PrismaService satisfies it. */
export interface PlatformAdminSeederDeps {
  connectedAccount: {
    findFirst(args: {
      where: { email: string };
    }): Promise<{ id: string } | null>;
  };
  platformAdmin: {
    upsert(args: {
      where: { email: string };
      update: { passwordHash: string; name: string | null };
      create: { email: string; passwordHash: string; name: string | null };
    }): Promise<SeededPlatformAdmin>;
  };
}

/** Raised when a would-be operator email is already a tenant user. */
export class PlatformIdentityConflictError extends Error {
  constructor(email: string) {
    super(
      `Cannot seed platform admin "${email}": that email already belongs to a ` +
        `tenant user. Platform operators must be a separate identity (separation of duties).`,
    );
    this.name = 'PlatformIdentityConflictError';
  }
}

export function normalizePlatformEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function seedPlatformAdmin(
  deps: PlatformAdminSeederDeps,
  input: SeedPlatformAdminInput,
): Promise<SeededPlatformAdmin> {
  const email = normalizePlatformEmail(input.email);
  const name = input.name ?? null;

  // Separation of duties: never let a tenant user become a platform operator.
  const existingTenantUser = await deps.connectedAccount.findFirst({
    where: { email },
  });
  if (existingTenantUser) {
    throw new PlatformIdentityConflictError(email);
  }

  // Upsert keeps re-seeding idempotent (e.g. rotating a password).
  return deps.platformAdmin.upsert({
    where: { email },
    update: { passwordHash: input.passwordHash, name },
    create: { email, passwordHash: input.passwordHash, name },
  });
}
