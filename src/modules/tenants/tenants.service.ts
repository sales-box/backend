import {
  Injectable,
  NotFoundException,
  BadRequestException,
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

  async signup(dto: SignupTenantDto) {
    const token = uuidv4();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);
    // Stored lowercased so every later lookup — resend, verify, set-password —
    // compares the same shape. This address is the only link between a pending
    // tenant and the person who started it.
    const adminEmail = dto.adminEmail.trim().toLowerCase();

    // Reclaiming an in-flight signup is scoped to the same company AND the same
    // address. Matching on company name alone let anyone who guessed a company
    // name take over its pending registration by "signing up" again.
    const existingPending = await this.prisma.tenant.findFirst({
      where: {
        companyName: dto.companyName,
        status: 'pending',
        OR: [{ adminEmail }, { adminEmail: null }],
      },
    });

    if (existingPending) {
      await this.prisma.tenant.update({
        where: { id: existingPending.id },
        data: {
          adminEmail,
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
    verifyUrl.searchParams.set('email', dto.adminEmail);
    const verificationLink = verifyUrl.toString();

    try {
      await this.transporter.sendMail({
        // Must send AS the authenticated SMTP account — Gmail SMTP rejects a
        // mismatched From (the old hard-coded noreply@salescopilot.com failed
        // silently, so no verification email ever reached the admin). Same
        // convention as the working SE invite email (email-notify.service).
        from: this.config.getOrThrow<string>('SMTP_USER'),
        to: dto.adminEmail,
        subject: 'Verify your company account',
        // Plain-text fallback alongside the HTML part (some providers/filters
        // drop HTML-only mail — mirrors the SE invite fix).
        text: `Welcome to Sales Copilot!\n\nVerify your company account by opening this link:\n${verificationLink}\n\nThis link expires in 24 hours.`,
        html: `<p>Welcome to Sales Copilot!</p><p>Please verify your account by clicking: <a href="${verificationLink}">Verify Account</a></p>`,
      });
      this.logger.log(`Activation email sent to ${dto.adminEmail}`);
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
    const tenant = await this.prisma.tenant.findFirst({
      where: {
        status: 'pending',
        adminEmail: email,
        ...(dto.companyName ? { companyName: dto.companyName } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!tenant) {
      // Deliberately indistinguishable from success: telling a caller whether
      // an address has a pending registration is an enumeration oracle. No
      // token is rotated and no mail is sent.
      this.logger.log(
        'Resend requested for an address with no pending registration; nothing sent',
      );
      return { message: 'Verification email resent successfully.' };
    }

    await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
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
