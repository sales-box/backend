import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { gmail_v1, google } from 'googleapis';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService } from '../auth/crypto.service';

/**
 * Small wrapper around stored OAuth credentials.
 * Other services ask for a Gmail client and do not need to know about
 * Prisma, encryption, or Google OAuth setup.
 */
@Injectable()
export class GmailClientProvider {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async getClientForAccount(
    email: string,
    tenantId?: string,
  ): Promise<gmail_v1.Gmail> {
    const account = tenantId
      ? await this.prisma.connectedAccount.findUnique({
          where: { tenantId_email: { tenantId, email } },
        })
      : await this.prisma.connectedAccount.findFirst({
          where: { email },
        });

    if (!account || account.status !== 'connected') {
      throw new NotFoundException(
        `Connected Gmail account not found: ${email}`,
      );
    }

    const oauth2 = new google.auth.OAuth2(
      this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      this.config.getOrThrow<string>('GOOGLE_REDIRECT_URI'),
    );

    oauth2.setCredentials({
      access_token: this.crypto.decrypt(account.accessToken),
      refresh_token: account.refreshToken
        ? this.crypto.decrypt(account.refreshToken)
        : undefined,
      expiry_date: account.tokenExpiresAt?.getTime(),
      scope: account.scope ?? undefined,
    });

    return google.gmail({ version: 'v1', auth: oauth2 });
  }
}
