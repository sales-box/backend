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

  async createClient(emailAccount: string): Promise<gmail_v1.Gmail> {
    const userCredentials =
      await this.authService.getUserCredentials(emailAccount);

    const auth = new google.auth.OAuth2({
      clientId: this.configService.get<string>('GOOGLE_CLIENT_ID'),
      clientSecret: this.configService.get<string>('GOOGLE_CLIENT_SECRET'),
    });

    auth.setCredentials(userCredentials);

    return google.gmail({ version: 'v1', auth });
  }
}
