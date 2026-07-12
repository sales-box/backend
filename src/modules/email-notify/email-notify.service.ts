import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * Outbound transactional email (invites, notifications). Separate from the Gmail
 * module, which only READS mail. The transporter is created lazily so unit tests
 * that never send email don't need SMTP configured.
 */
@Injectable()
export class EmailNotifyService {
  private readonly logger = new Logger(EmailNotifyService.name);
  private transporter?: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {}

  private getTransporter(): nodemailer.Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.config.get<string>('SMTP_HOST'),
        port: parseInt(this.config.get<string>('SMTP_PORT') ?? '587', 10),
        secure: false,
        auth: {
          user: this.config.get<string>('SMTP_USER'),
          pass: this.config.get<string>('SMTP_PASS'),
        },
      });
    }
    return this.transporter;
  }

  /**
   * Emails a newly-granted SE the Gmail-extension install link. Failures are
   * logged, not thrown — a flaky mail server must never roll back the grant.
   */
  async sendSeInvite(email: string): Promise<void> {
    const installUrl =
      this.config.get<string>('EXTENSION_INSTALL_URL') ??
      this.config.get<string>('FRONTEND_DASHBOARD_URL') ??
      'https://sales-copilot.app/extension';

    try {
      await this.getTransporter().sendMail({
        from: this.config.get<string>('SMTP_USER'),
        to: email,
        subject: 'You have been invited to Sales Copilot',
        html: `<p>You have been granted access to Sales Copilot.</p>
               <p>Install the Gmail extension to get started:
               <a href="${installUrl}">${installUrl}</a></p>`,
      });
      this.logger.log(`SE invite email sent to ${email}`);
    } catch (err) {
      this.logger.error(`Failed to send SE invite to ${email}: ${String(err)}`);
    }
  }
}
