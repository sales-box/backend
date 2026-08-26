import { AuthService } from '@/modules/auth/auth.service';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google, gmail_v1 } from 'googleapis';

@Injectable()
export class GmailClientFactory {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * `tenantId` is required and comes first: a Gmail client grants access to a
   * mailbox's OAuth credentials, and callers routinely take the email address
   * from a request body. Putting the tenant first makes a forgotten argument a
   * type error rather than a silently swapped string.
   */
  async createClient(
    tenantId: string,
    emailAccount: string,
  ): Promise<gmail_v1.Gmail> {
    const userCredentials = await this.authService.getUserCredentials(
      emailAccount,
      tenantId,
    );

    const auth = new google.auth.OAuth2({
      clientId: this.configService.get<string>('GOOGLE_CLIENT_ID'),
      clientSecret: this.configService.get<string>('GOOGLE_CLIENT_SECRET'),
    });

    auth.setCredentials(userCredentials);

    return google.gmail({ version: 'v1', auth });
  }
}
