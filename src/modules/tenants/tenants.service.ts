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

    const apiUrl = this.config.getOrThrow<string>('API_URL');
    const verificationLink = `${apiUrl}/tenants/verify?token=${token}&email=${encodeURIComponent(dto.adminEmail)}`;

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

    const activeTenant = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.tenant.update({
        where: { id: tenant.id },
        data: {
          status: 'active',
          emailVerifiedAt: new Date(),
          emailVerificationToken: null,
          emailVerificationExpiresAt: null,
        },
      });

      // TODO (Role 2 - Karim):
      // The tenant is now active. You must call your AllowlistService.grantAccess() here.
      // Ensure your method accepts the Prisma transaction client `tx` so it remains atomic.
      // Example: await this.allowlistService.grantAccess(tx, updated.id, adminEmail);

      return updated;
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
}
