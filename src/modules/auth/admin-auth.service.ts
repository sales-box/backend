import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { PrismaService } from '../../database/prisma.service';

/** Claims carried by an admin JWT — shape agreed with the tenant guards. */
export interface AdminJwtPayload {
  /** ConnectedAccount id. */
  sub: string;
  tenantId: string | null;
  isAdmin: boolean;
  email: string;
}

// OWASP-recommended argon2id parameters (memory 19 MiB, 2 iterations).
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Email + password login for tenant admins.
   * Every failure is the same generic 401 — no user enumeration.
   */
  async adminLoginWithPassword(
    email: string,
    password: string,
  ): Promise<{ token: string }> {
    // Guard against an admin email that legitimately exists under multiple
    // tenants. findFirst would silently pick one, which is a data-integrity
    // hazard. Detect the ambiguity early and require a product decision.
    const matchCount = await this.prisma.connectedAccount.count({
      where: { email, isAdmin: true },
    });
    if (matchCount > 1) {
      // More than one admin row shares this email across different tenants.
      // Silently authenticating against whichever Prisma returns first would
      // hand the caller an arbitrary tenant's session. Surface this clearly
      // so a human (or future multi-tenant login UI) can resolve it.
      throw new ConflictException(
        'Multiple accounts found for this email — contact support',
      );
    }

    const account = await this.prisma.connectedAccount.findFirst({
      where: { email, isAdmin: true },
    });

    if (!account?.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await verify(account.passwordHash, password).catch(
      () => false,
    );
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload: AdminJwtPayload = {
      sub: account.id,
      tenantId: account.tenantId,
      isAdmin: account.isAdmin,
      email: account.email,
    };
    this.logger.log(`Admin password login: ${email}`);
    return { token: await this.jwt.signAsync({ ...payload }) };
  }

  /**
   * First-time password setup for a tenant admin. This is the identity-linking
   * step: the password lands on the SAME ConnectedAccount row the Google
   * OAuth flow created for that email — never a duplicate account.
   *
   * Guarded by: account must exist (Google-connected first), must not already
   * have a password, tenant must be active, and the tenant must not already
   * have a different admin (first-admin-per-tenant rule).
   * TODO(tenant-verification): bind this to the tenant email-verification
   * token once the allowlist grant step (Role 2) lands in the verify flow.
   */
  async setAdminPassword(
    email: string,
    password: string,
    tenantId: string,
  ): Promise<{ linked: true }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });
    if (!tenant || tenant.status !== 'active') {
      throw new BadRequestException('Tenant is not active');
    }

    // Scope the lookup to [tenantId, email] so an account belonging to a
    // different tenant with the same email cannot inadvertently receive admin
    // privileges for this tenant.
    const account = await this.prisma.connectedAccount.findFirst({
      where: { tenantId, email },
    });
    if (!account) {
      throw new BadRequestException(
        'Connect the Google account first, then set a password',
      );
    }
    if (account.passwordHash) {
      throw new ConflictException('A password is already set for this admin');
    }

    const existingAdmin = await this.prisma.connectedAccount.findFirst({
      where: { tenantId, isAdmin: true, NOT: { id: account.id } },
    });
    if (existingAdmin) {
      throw new ConflictException('This tenant already has an admin');
    }

    const passwordHash = await hash(password, ARGON2_OPTIONS);
    await this.linkAdminIdentities(tenantId, account.id, passwordHash);
    return { linked: true };
  }

  /**
   * Links the password identity onto the existing Google-connected account:
   * same row gains passwordHash + isAdmin + tenantId. Never creates a second
   * account for the same admin.
   */
  async linkAdminIdentities(
    tenantId: string,
    googleAccountId: string,
    passwordHash: string,
  ): Promise<void> {
    await this.prisma.connectedAccount.update({
      where: { id: googleAccountId },
      data: { passwordHash, isAdmin: true, tenantId },
    });
    this.logger.log(
      `Admin identities linked for account ${googleAccountId} (tenant ${tenantId})`,
    );
  }
}
