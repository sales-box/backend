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
   * Tells a Sales Engineer their access has been turned off.
   *
   * Deliberately plain and non-accusatory. We do not know WHY the admin revoked
   * access — offboarding, a role change, a mistake — so the copy states the fact
   * and points at the person who can undo it. Guessing at a reason, or wording
   * it like a warning, would be wrong about as often as it was right.
   *
   * @param raise - see sendSeInvite. The queue processor passes true so BullMQ
   *   can retry; direct callers keep the swallow-and-log behaviour, because a
   *   mail failure must never make the revocation itself look like it failed.
   */
  async sendSeRevoked(
    email: string,
    companyName = 'Sales Copilot',
    raise = false,
  ): Promise<void> {
    const seName = email.split('@')[0];

    try {
      await this.getTransporter().sendMail({
        from: this.config.get<string>('SMTP_USER'),
        to: email,
        subject: `Your Inbox Sales Copilot access has ended`,
        text: `Hi ${seName},

Your access to the Inbox Sales Copilot for ${companyName} has been turned off by an administrator.

What this means:
- The Copilot panel will no longer load in your Gmail.
- You will not be able to sign in to the extension.
- Nothing has been deleted from your own mailbox. Your email is untouched.

You can remove the extension from Chrome if you no longer need it:
Open chrome://extensions, find Inbox Sales Copilot, and click Remove.

If you think this was a mistake, please contact your administrator at ${companyName} — they can restore your access.

Best regards,
The ${companyName} Team`,
        html: `
<p>Hi ${seName},</p>
<p>Your access to the Inbox Sales Copilot for <strong>${companyName}</strong> has been turned off by an administrator.</p>

<p><strong>What this means</strong></p>
<ul>
  <li>The Copilot panel will no longer load in your Gmail.</li>
  <li>You will not be able to sign in to the extension.</li>
  <li>Nothing has been deleted from your own mailbox. Your email is untouched.</li>
</ul>

<p>You can remove the extension from Chrome if you no longer need it: open <code>chrome://extensions</code>, find <strong>Inbox Sales Copilot</strong>, and click <strong>Remove</strong>.</p>

<p>If you think this was a mistake, please contact your administrator at ${companyName} — they can restore your access.</p>

<p>Best regards,<br>The ${companyName} Team</p>
        `,
      });
      this.logger.log(`SE revocation notice sent to ${email}`);
    } catch (err) {
      this.logger.error(
        `Failed to send revocation notice to ${email}: ${String(err)}`,
      );
      if (raise) throw err;
    }
  }

  /**
   * Emails a newly-granted SE the Gmail-extension install link.
   *
   * @param raise - When false (the default) a send failure is logged and
   *   swallowed, because a flaky mail server must never roll back the grant.
   *   The SE-invite queue processor passes true so BullMQ sees the failure and
   *   retries; there the grant is already committed, so throwing is safe and a
   *   swallowed error would silently drop the invite forever.
   */
  async sendSeInvite(
    email: string,
    companyName = 'Sales Copilot',
    raise = false,
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
        text: `Hi ${seName},

Welcome to the team! You have been granted access to the Inbox Sales Copilot.

This AI-powered assistant lives directly inside your Gmail and provides smart, context-aware reply suggestions for your client emails based on our knowledge base and history.

To get started, please follow these steps to install the extension:

Step 1: Download the Extension
Download the extension ZIP file here: ${installUrl}
Extract/unzip the file to a folder on your computer (e.g., your Desktop or Documents folder).

Step 2: Install in Chrome
Open Google Chrome and go to chrome://extensions in your address bar.
In the top right corner, turn on Developer mode.
Click the Load unpacked button in the top left.
Select the folder where you extracted the extension (make sure you select the folder containing the manifest.json file).

Step 3: Pin and Sign In
Click the "Puzzle" icon in your Chrome toolbar and pin Inbox Sales Copilot.
Open Gmail (mail.google.com).
You will see the Copilot panel open on the right side of your screen.
Click Sign in with Google and select your company email address.

That's it! If you run into any issues, please reach out to your manager or IT support.

Best regards,
The ${companyName} Team`,
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
      if (raise) throw err;
    }
  }
}
