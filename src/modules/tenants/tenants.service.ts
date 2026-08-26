import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  GoneException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/database/prisma.service';
import { SignupTenantDto, ResendVerificationDto } from './tenants.dto';
import { v4 as uuidv4 } from 'uuid';
import * as nodemailer from 'nodemailer';
import { Prisma } from '@prisma/client';
import { UpdateTenantDto } from './dto/update-tenant.dto';

/**
 * Statuses a fresh signup is allowed to take over instead of creating a second
 * tenant for the same address.
 *
 * `pending`   — a signup still in flight; the person is retrying.
 * `abandoned` — a pending signup the daily cleanup aged out after 7 days
 *               (tenant-cleanup.service.ts). It is not a real account, so
 *               refusing it would lock somebody out permanently for having
 *               been slow.
 *
 * Everything else (`active`, `suspended`, `offboarded`) means a real account
 * exists and signup must stop.
 */
const RECLAIMABLE_STATUSES = new Set<string>(['pending', 'abandoned']);

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);
  private transporter: nodemailer.Transporter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.transporter = nodemailer.createTransport({
      host: this.config.getOrThrow<string>('SMTP_HOST'),
      port: parseInt(this.config.getOrThrow<string>('SMTP_PORT'), 10),
      secure: false,
      auth: {
        user: this.config.getOrThrow<string>('SMTP_USER'),
        pass: this.config.getOrThrow<string>('SMTP_PASS'),
      },
    });
  }

  /**
   * Refuses an admin email that already belongs to a tenant user.
   *
   * Separation of duties, the same rule `platform-admin.seeder.ts` applies to
   * operators. Without it an SE at company A can register company B with their
   * own address: signup and email verification both succeed (neither looks at
   * who owns the address), leaving a verified, ACTIVE, admin-less tenant that
   * no cleanup job touches — the abandonment cron only sweeps `pending` rows.
   * The person is then stopped at set-password with "Connect the Google
   * account first", which they cannot act on. Fail here instead, where the
   * reason can still be explained.
   */
  private async assertEmailIsNotATenantUser(email: string): Promise<void> {
    const [tenantUser, invited] = await Promise.all([
      this.prisma.connectedAccount.findFirst({
        where: { email },
        select: { id: true },
      }),
      this.prisma.allowlistEntry.findFirst({
        where: { email, status: { in: ['granted', 'verified'] } },
        select: { id: true },
      }),
    ]);

    if (tenantUser || invited) {
      throw new ConflictException(
        'That email is already used by a member of another company. ' +
          'Register with a different address, or ask that company to remove ' +
          'your access first.',
      );
    }
  }

  /**
   * True when a tenant has no sign-in identity of any kind behind it.
   *
   * `status: 'active'` is set the moment the emailed link is opened, which is
   * several steps before a registration is actually finished: the Google
   * connect and the password still have to happen, and each can fail or simply
   * be abandoned. A tenant left in that gap is `active` with zero
   * ConnectedAccounts — nobody can sign in to it, its verification token is
   * already spent, and both signup and resend used to refuse the address as
   * "already registered". That is a dead end for a person who never got an
   * account at all, so an unfinished signup must stay resumable.
   *
   * Zero accounts is the deliberately strict test: it means there is provably
   * nobody — no admin, no invited SE — whose access a reset could disrupt.
   */
  private async hasNoAccounts(tenantId: string): Promise<boolean> {
    const accounts = await this.prisma.connectedAccount.count({
      where: { tenantId },
    });
    return accounts === 0;
  }

  async signup(dto: SignupTenantDto) {
    const token = uuidv4();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);
    // Stored lowercased so every later lookup — resend, verify, set-password —
    // compares the same shape. This address is the only link between a pending
    // tenant and the person who started it.
    const adminEmail = dto.adminEmail.trim().toLowerCase();

    // Separation of duties: an address that already belongs to somebody else's
    // company cannot start a new one. Runs BEFORE the own-account check below,
    // which only looks at tenants this address owns and would let an SE at
    // another company straight through.
    await this.assertEmailIsNotATenantUser(adminEmail);

    // One signup per address.
    //
    // Signing up twice used to create a SECOND tenant every time the company
    // name differed, so a single address could end up owning several companies.
    // That is bad on its own, and it also makes "resend my link" ambiguous:
    // with two pending tenants on one address the resend picks the newest and
    // the older one can never be verified at all.
    const existingForEmail = await this.prisma.tenant.findFirst({
      where: { adminEmail },
      orderBy: { createdAt: 'desc' },
    });

    if (
      existingForEmail &&
      !RECLAIMABLE_STATUSES.has(existingForEmail.status) &&
      !(await this.hasNoAccounts(existingForEmail.id))
    ) {
      // A real account already exists for this address. Say so plainly rather
      // than quietly starting a second registration the person can never
      // finish. The company name is deliberately NOT included: an anonymous
      // caller must not be able to read which company an address belongs to.
      //
      // An `active` tenant with no accounts behind it is NOT this case: see
      // hasNoAccounts(). It falls through and is reclaimed below, which is the
      // only way out for someone whose signup broke after verification.
      this.logger.log('Signup refused: address already has a live account');
      throw new ConflictException(
        'This email is already registered. Please sign in instead.',
      );
    }

    // Reclaim rather than duplicate. `pending` is a signup still in flight;
    // `abandoned` is only a pending signup that passed the 7-day cleanup
    // (tenant-cleanup.service.ts), so refusing those would lock someone out of
    // the product for good just because they were slow the first time.
    const reclaimable =
      existingForEmail ??
      (await this.prisma.tenant.findFirst({
        where: {
          companyName: dto.companyName,
          status: 'pending',
          adminEmail: null,
        },
      }));

    if (reclaimable) {
      await this.prisma.tenant.update({
        where: { id: reclaimable.id },
        data: {
          // The person may have corrected the company name on the second
          // attempt, so take the newer one.
          companyName: dto.companyName,
          adminEmail,
          // An abandoned signup comes back to life as a normal pending one.
          status: 'pending',
          emailVerificationToken: token,
          emailVerificationExpiresAt: expiresAt,
        },
      });
    } else {
      await this.prisma.tenant.create({
        data: {
          companyName: dto.companyName,
          status: 'pending',
          adminEmail,
          emailVerificationToken: token,
          emailVerificationExpiresAt: expiresAt,
        },
      });
    }

    // Point the admin at the frontend /verify page (which calls the API and
    // then routes to set-password), NOT the raw API endpoint (that returns
    // JSON in the browser). Origin comes from the configured dashboard URL.
    const frontendOrigin = new URL(
      this.config.getOrThrow<string>('FRONTEND_DASHBOARD_URL'),
    ).origin;
    const verifyUrl = new URL('/verify', frontendOrigin);
    verifyUrl.searchParams.set('token', token);
    verifyUrl.searchParams.set('email', adminEmail);
    const verificationLink = verifyUrl.toString();

    try {
      await this.transporter.sendMail({
        // Must send AS the authenticated SMTP account — Gmail SMTP rejects a
        // mismatched From (the old hard-coded noreply@salescopilot.com failed
        // silently, so no verification email ever reached the admin). Same
        // convention as the working SE invite email (email-notify.service).
        from: this.config.getOrThrow<string>('SMTP_USER'),
        to: adminEmail,
        subject: 'Verify your company account',
        // Plain-text fallback alongside the HTML part (some providers/filters
        // drop HTML-only mail — mirrors the SE invite fix).
        text: `Welcome to Sales Copilot!\n\nVerify your company account by opening this link:\n${verificationLink}\n\nThis link expires in 24 hours.`,
        html: `<p>Welcome to Sales Copilot!</p><p>Please verify your account by clicking: <a href="${verificationLink}">Verify Account</a></p>`,
      });
      this.logger.log(`Activation email sent to ${adminEmail}`);
    } catch (error: any) {
      this.logger.error(
        'Failed to send activation email. Ensure SMTP is configured.',
        error instanceof Error ? error.stack : String(error),
      );
    }

    return {
      message:
        'Signup successful. Please check your email to activate your tenant.',
    };
  }

  async resendVerification(dto: ResendVerificationDto) {
    const token = uuidv4();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);
    const email = dto.email.trim().toLowerCase();

    // The tenant is resolved from the address that started the signup, and
    // from nothing else.
    //
    // This used to fall back to "the most recently created pending tenant"
    // whenever companyName was absent — which the dashboard omits as soon as
    // the signup tab's sessionStorage is gone. The server then rotated THAT
    // tenant's token and mailed it to the caller, so the person asking for
    // their own link received a link that verifies a stranger's company while
    // their own registration stayed stuck forever. It was also the first step
    // of a full tenant takeover: name any company, receive its fresh token.
    let tenant = await this.prisma.tenant.findFirst({
      where: {
        status: 'pending',
        adminEmail: email,
        ...(dto.companyName ? { companyName: dto.companyName } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!tenant) {
      // No signup in flight. Before going quiet, check for the one case that
      // looks finished but is not: a tenant already flipped to `active` by the
      // verification link whose signup then broke before it produced any
      // account (see hasNoAccounts). Its token is spent, so the emailed link is
      // dead, and staying silent here strands the person permanently — the
      // exact "resend does nothing" they are reporting.
      const existing = await this.prisma.tenant.findFirst({
        where: { adminEmail: email },
        orderBy: { createdAt: 'desc' },
      });

      if (existing && !RECLAIMABLE_STATUSES.has(existing.status)) {
        if (await this.hasNoAccounts(existing.id)) {
          // Resume the signup: the update below rewinds it to `pending` and
          // issues a fresh token, so the normal verify → connect → password
          // flow can run again from the top.
          this.logger.log(
            'Resending for a tenant whose signup never produced an account',
          );
          tenant = existing;
        } else {
          // A genuinely finished registration. Telling the caller so leaks
          // nothing new — signup() already answers the same question for the
          // same address — and is far better than a success message that is a
          // lie about mail nobody sent.
          throw new ConflictException(
            'This account is already verified. Please sign in instead.',
          );
        }
      }
    }

    if (!tenant) {
      // Genuinely unknown address: stay indistinguishable from success, so the
      // endpoint cannot be used to enumerate who has an account here. No token
      // is rotated and no mail is sent.
      this.logger.log(
        'Resend requested for an address with no pending registration; nothing sent',
      );
      return { message: 'Verification email resent successfully.' };
    }

    await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        // A no-op for a signup still in flight, and the rewind that makes a
        // stranded one resumable: verify() only accepts a `pending` tenant, so
        // the fresh token below would be rejected without this. Safe precisely
        // because hasNoAccounts() proved nobody can be signed in to lose access.
        status: 'pending',
        emailVerifiedAt: null,
        emailVerificationToken: token,
        emailVerificationExpiresAt: expiresAt,
      },
    });

    const frontendOrigin = new URL(
      this.config.getOrThrow<string>('FRONTEND_DASHBOARD_URL'),
    ).origin;
    const verifyUrl = new URL('/verify', frontendOrigin);
    verifyUrl.searchParams.set('token', token);
    verifyUrl.searchParams.set('email', email);
    const verificationLink = verifyUrl.toString();

    try {
      await this.transporter.sendMail({
        from: this.config.getOrThrow<string>('SMTP_USER'),
        to: email,
        subject: 'Verify your company account',
        text: `Welcome to Sales Copilot!\n\nVerify your company account by opening this link:\n${verificationLink}\n\nThis link expires in 24 hours.`,
        html: `<p>Welcome to Sales Copilot!</p><p>Please verify your account by clicking: <a href="${verificationLink}">Verify Account</a></p>`,
      });
      this.logger.log(`Resent activation email to ${email}`);
    } catch (error: unknown) {
      // A resend is a request the user made on purpose and is waiting on. This
      // used to log and then return "resent successfully" regardless, so a
      // misconfigured SMTP host looked identical to a delivered email — the
      // user waits for a message that was never sent.
      this.logger.error(
        'Failed to resend activation email. Ensure SMTP is configured.',
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException(
        'We could not send the verification email just now. Please try again in a moment.',
      );
    }

    return {
      message: 'Verification email resent successfully.',
    };
  }

  async verify(token: string, adminEmail: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { emailVerificationToken: token },
    });

    this.logger.log(`Attempting to verify tenant for admin: ${adminEmail}`);

    if (!tenant) throw new NotFoundException('Invalid verification token');
    if (tenant.status !== 'pending')
      throw new BadRequestException('Tenant is already verified or abandoned');

    // The email argument used to be logged and then ignored, so a token that
    // reached the wrong inbox — by a mis-sent resend, a forwarded mail, or the
    // takeover chain — activated the company for whoever presented it. Bind the
    // two: this token belongs to this signup address.
    //
    // Tenants created before admin_email existed have none recorded; those keep
    // the old token-only behaviour rather than becoming unverifiable.
    if (
      tenant.adminEmail &&
      tenant.adminEmail !== adminEmail.trim().toLowerCase()
    ) {
      this.logger.warn(
        `Verification token for tenant ${tenant.id} presented with a non-matching address`,
      );
      throw new NotFoundException('Invalid verification token');
    }

    if (
      tenant.emailVerificationExpiresAt &&
      tenant.emailVerificationExpiresAt < new Date()
    ) {
      throw new GoneException('Verification token has expired');
    }

    // The admin is deliberately NOT granted onto the allowlist: the allowlist
    // is the SE guest list and counts toward the plan's SE seat cap. The admin
    // authenticates through set-password + admin login instead (option "a").
    const activeTenant = await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        status: 'active',
        emailVerifiedAt: new Date(),
        emailVerificationToken: null,
        emailVerificationExpiresAt: null,
      },
    });

    return {
      message: 'Tenant successfully activated!',
      tenantId: activeTenant.id,
    };
  }

  async getTenant(id: string) {
    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(id)) {
      throw new NotFoundException('Tenant not found');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: {
        id: true,
        companyName: true,
        tier: true,
        status: true,
        subscriptionStatus: true,
      },
    });

    if (!tenant) throw new NotFoundException('Tenant not found');
    return tenant;
  }

  async updateTenant(id: string, dto: UpdateTenantDto) {
    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(id)) {
      throw new NotFoundException(`Tenant with ID ${id} not found`);
    }

    try {
      return await this.prisma.tenant.update({
        where: { id },
        data: {
          companyName: dto.companyName,
        },
        select: {
          id: true,
          companyName: true,
          tier: true,
          status: true,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2025' || error.code === 'P2023')
      ) {
        throw new NotFoundException(`Tenant with ID ${id} not found`);
      }
      this.logger.error(`Failed to update tenant ${id}`, error);
      throw error;
    }
  }
}
