import {
  Injectable,
  NotFoundException,
  BadRequestException,
  GoneException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/database/prisma.service';
import { SignupTenantDto } from './tenants.dto';
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

    await this.prisma.tenant.create({
      data: {
        companyName: dto.companyName,
        status: 'pending',
        emailVerificationToken: token,
        emailVerificationExpiresAt: expiresAt,
      },
    });

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
        from: '"Sales Copilot" <noreply@salescopilot.com>',
        to: dto.adminEmail,
        subject: 'Verify your company account',
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

  async verify(token: string, adminEmail: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { emailVerificationToken: token },
    });

    this.logger.log(`Attempting to verify tenant for admin: ${adminEmail}`);

    if (!tenant) throw new NotFoundException('Invalid verification token');
    if (tenant.status !== 'pending')
      throw new BadRequestException('Tenant is already verified or abandoned');

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
        error.code === 'P2025'
      ) {
        throw new NotFoundException(`Tenant with ID ${id} not found`);
      }
      this.logger.error(`Failed to update tenant ${id}`, error);
      throw error;
    }
  }
}
