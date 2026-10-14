import {
  seedPlatformAdmin,
  PlatformIdentityConflictError,
  type PlatformAdminSeederDeps,
  type SeededPlatformAdmin,
} from './platform-admin.seeder';

/**
 * In-memory fake of the Prisma slice the seeder needs, so we assert on real
 * state (what got created) rather than which mock was called.
 */
function makeFakeDeps(opts: { existingTenantEmails?: string[] } = {}) {
  const platformAdmins: SeededPlatformAdmin[] = [];
  const tenantEmails = new Set(
    (opts.existingTenantEmails ?? []).map((e) => e.toLowerCase()),
  );

  const deps: PlatformAdminSeederDeps = {
    connectedAccount: {
      findFirst: ({ where }) =>
        Promise.resolve(tenantEmails.has(where.email) ? { id: 'ca-1' } : null),
    },
    platformAdmin: {
      upsert: ({ where, create }) => {
        const existing = platformAdmins.find((a) => a.email === where.email);
        if (existing) {
          existing.name = create.name;
          return Promise.resolve(existing);
        }
        const row: SeededPlatformAdmin = {
          id: `pa-${platformAdmins.length + 1}`,
          email: create.email,
          name: create.name,
        };
        platformAdmins.push(row);
        return Promise.resolve(row);
      },
    },
  };

  return { deps, platformAdmins };
}

describe('seedPlatformAdmin', () => {
  it('refuses an email that already belongs to a tenant user (separation of duties)', async () => {
    const { deps, platformAdmins } = makeFakeDeps({
      existingTenantEmails: ['boss@acme.com'],
    });

    await expect(
      seedPlatformAdmin(deps, {
        email: 'boss@acme.com',
        passwordHash: 'hash',
      }),
    ).rejects.toBeInstanceOf(PlatformIdentityConflictError);

    expect(platformAdmins).toHaveLength(0);
  });

  it('creates a platform admin when the email is not used by any tenant', async () => {
    const { deps, platformAdmins } = makeFakeDeps();

    const admin = await seedPlatformAdmin(deps, {
      email: 'ops@salesbox.dev',
      passwordHash: 'hash',
      name: 'Ops',
    });

    expect(admin.email).toBe('ops@salesbox.dev');
    expect(admin.name).toBe('Ops');
    expect(platformAdmins).toHaveLength(1);
  });

  it('normalizes the email (trim + lowercase) before checking and creating', async () => {
    const { deps, platformAdmins } = makeFakeDeps({
      existingTenantEmails: ['taken@acme.com'],
    });

    // Same address, different casing/spacing -> must still be rejected.
    await expect(
      seedPlatformAdmin(deps, {
        email: '  TAKEN@Acme.com ',
        passwordHash: 'hash',
      }),
    ).rejects.toBeInstanceOf(PlatformIdentityConflictError);

    const admin = await seedPlatformAdmin(deps, {
      email: '  OPS@Salesbox.DEV ',
      passwordHash: 'hash',
    });
    expect(admin.email).toBe('ops@salesbox.dev');
    expect(platformAdmins).toHaveLength(1);
  });

  it('is idempotent — seeding the same operator twice keeps a single row', async () => {
    const { deps, platformAdmins } = makeFakeDeps();

    await seedPlatformAdmin(deps, {
      email: 'ops@salesbox.dev',
      passwordHash: 'h1',
    });
    await seedPlatformAdmin(deps, {
      email: 'ops@salesbox.dev',
      passwordHash: 'h2',
    });

    expect(platformAdmins).toHaveLength(1);
  });
});
