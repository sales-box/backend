import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `connected_accounts` rows hold encrypted Gmail OAuth tokens. A lookup that is
 * not scoped by tenant can hand one tenant another tenant's mailbox
 * credentials — which is exactly what happened via GmailClientFactory, where
 * `getUserCredentials` accepted an optional tenantId and fell back to an
 * email-only scan. `findUnique` on the [tenantId, email] composite key is the
 * only shape that is safe by construction.
 *
 * This test is deliberately crude. Its value is that it fails loudly when the
 * pattern comes back, which is the property whose absence caused the original
 * breach.
 */
describe('connectedAccount lookups are tenant-scoped', () => {
  /**
   * Files allowed to resolve an account without a tenant, each with a reason.
   * Adding an entry here requires a security review — these are the only
   * places where an email alone may identify an account.
   */
  const ALLOWED = new Map<string, string>([
    [
      'auth/auth.service.ts',
      'OAuth upsert: admin-first-connect happens before any tenant link exists, ' +
        'and the email comes from a Google-verified token, not a request body.',
    ],
    [
      'ai/classifier/classifier.processor.ts',
      'Pub/Sub job entry point: the notification carries only the mailbox ' +
        'address, and this lookup is what resolves it to a tenant.',
    ],
    [
      'auth/admin-auth.service.ts',
      'Admin login: identity is being established from email + password, so ' +
        'there is no authenticated tenant yet to scope by.',
    ],
    [
      'platform/platform-admin.seeder.ts',
      'Separation of duties: must deliberately look ACROSS all tenants to ' +
        'refuse an email that already belongs to a tenant user.',
    ],
  ]);

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
    });
  }

  it('has no unscoped connectedAccount lookup outside the reviewed allowlist', () => {
    const root = join(__dirname, '..');
    const offenders: string[] = [];

    for (const file of sourceFiles(root)) {
      const rel = file.slice(root.length + 1);
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(file, 'utf8');
      const pattern = /connectedAccount\.(findFirst|findMany)\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(src)) !== null) {
        // Look at the call's argument block. A lookup whose `where` names a
        // tenant is scoped and fine; one that never mentions the tenant is
        // the shape that leaked credentials.
        const args = src.slice(match.index, match.index + 400);
        if (!args.includes('tenantId')) {
          const line = src.slice(0, match.index).split('\n').length;
          offenders.push(`${rel}:${line}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('getUserCredentials requires a tenant and has no email-only fallback', () => {
    const src = readFileSync(join(__dirname, 'auth.service.ts'), 'utf8');
    const body = src.slice(src.indexOf('public async getUserCredentials'));
    const method = body.slice(0, body.indexOf('\n  public '));

    // The tenant must be a required parameter, not `tenantId?: string`.
    expect(method).toContain('tenantId: string,');
    expect(method).not.toContain('tenantId?: string');
    // And the scoped composite key must be the only lookup it performs.
    expect(method).toContain('tenantId_email');
    expect(method).not.toContain('findFirst');
  });
});
