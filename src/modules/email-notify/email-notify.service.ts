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
  async sendSeInvite(
    email: string,
    companyName = 'Sales Copilot',
  ): Promise<void> {
    const installUrl =
      this.config.get<string>('EXTENSION_INSTALL_URL') ??
      this.config.get<string>('FRONTEND_DASHBOARD_URL') ??
      'https://sales-copilot.app/extension';

    const seName = email.split('@')[0];

    try {
      await this.getTransporter().sendMail({
        from: this.config.get<string>('SMTP_USER'),
        to: email,
        subject: 'Welcome to Inbox Sales Copilot — Action Required',
        html: `
<p>Hi ${seName},</p>
<p>Welcome to the team! You have been granted access to the Inbox Sales Copilot.</p>
<p>This AI-powered assistant lives directly inside your Gmail and provides smart, context-aware reply suggestions for your client emails based on our knowledge base and history.</p>
<p>To get started, please follow these steps to install the extension:</p>

<p><strong>Step 1: Download the Extension</strong></p>
<ul>
  <li>Download the extension ZIP file here: <a href="${installUrl}">${installUrl}</a></li>
  <li>Extract/unzip the file to a folder on your computer (e.g., your Desktop or Documents folder).</li>
</ul>

<p><strong>Step 2: Install in Chrome</strong></p>
<ul>
  <li>Open Google Chrome and go to <code>chrome://extensions</code> in your address bar.</li>
  <li>In the top right corner, turn on <strong>Developer mode</strong>.</li>
  <li>Click the <strong>Load unpacked</strong> button in the top left.</li>
  <li>Select the folder where you extracted the extension (make sure you select the folder containing the <code>manifest.json</code> file).</li>
</ul>

<p><strong>Step 3: Pin and Sign In</strong></p>
<ul>
  <li>Click the "Puzzle" icon 🧩 in your Chrome toolbar and pin Inbox Sales Copilot.</li>
  <li>Open Gmail (mail.google.com).</li>
  <li>You will see the Copilot panel open on the right side of your screen.</li>
  <li>Click <strong>Sign in with Google</strong> and select your company email address.</li>
</ul>

<p>That's it! If you run into any issues, please reach out to your manager or IT support.</p>

<p>Best regards,<br>The ${companyName} Team</p>
        `,
      });
      this.logger.log(`SE invite email sent to ${email}`);
    } catch (err) {
      this.logger.error(`Failed to send SE invite to ${email}: ${String(err)}`);
    }
  }
}
