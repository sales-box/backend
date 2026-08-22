/**
 * Seed a platform operator (the Salesbox team's cross-tenant admin).
 *
 * Run from backend/:
 *   PLATFORM_ADMIN_EMAIL=ops@salesbox.dev \
 *   PLATFORM_ADMIN_PASSWORD='<strong-password>' \
 *   PLATFORM_ADMIN_NAME='Ops' \
 *   node --env-file=.env -r ts-node/register/transpile-only scripts/seed-platform-admin.ts
 *
 * Provide EITHER a plaintext PLATFORM_ADMIN_PASSWORD (hashed here with the same
 * argon2id params as admin login) OR a pre-computed PLATFORM_ADMIN_PASSWORD_HASH.
 * Nothing secret is ever written to git — only the hash reaches the database.
 *
 * Idempotent: re-running upserts the same operator (e.g. to rotate a password).
 * Refuses any email that already belongs to a tenant user (separation of duties).
 *
 * Deliberately does NOT boot the Nest app (which would start BullMQ workers and
 * the Gmail scheduler as a side effect) — it only touches the DB.
 */
import { PrismaClient } from '@prisma/client';
import { hash, Algorithm } from '@node-rs/argon2';
import {
  seedPlatformAdmin,
  PlatformIdentityConflictError,
} from '../src/modules/platform/platform-admin.seeder';

// Mirrors ARGON2_OPTIONS in admin-auth.service.ts (OWASP argon2id).
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function resolvePasswordHash(): Promise<string> {
  const preHashed = process.env.PLATFORM_ADMIN_PASSWORD_HASH;
  if (preHashed) return preHashed;
  const plaintext = requireEnv('PLATFORM_ADMIN_PASSWORD');
  return hash(plaintext, ARGON2_OPTIONS);
}

async function main() {
  const email = requireEnv('PLATFORM_ADMIN_EMAIL');
  const name = process.env.PLATFORM_ADMIN_NAME;
  const passwordHash = await resolvePasswordHash();

  const prisma = new PrismaClient();
  try {
    const admin = await seedPlatformAdmin(prisma, {
      email,
      passwordHash,
      name,
    });
    console.log(`✔ Platform admin ready: ${admin.email} (id: ${admin.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  if (err instanceof PlatformIdentityConflictError) {
    console.error(`ERROR: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
