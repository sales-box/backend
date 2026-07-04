import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { PrismaService } from '../../database/prisma.service';
import { withTimeout } from '../../common/with-timeout';
import { CryptoService } from './crypto.service';
import { describeOAuthError } from './oauth-error.util';
import { EventEmitter2 } from '@nestjs/event-emitter';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GMAIL_API_VERSION = 'v1';
const GMAIL_SELF_USER = 'me';
const GOOGLE_REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  buildGoogleAuthUrl(): string {
    const url = new URL(GOOGLE_AUTH_ENDPOINT);

    url.search = new URLSearchParams({
      client_id: this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      redirect_uri: this.config.getOrThrow<string>('GOOGLE_REDIRECT_URI'),
      response_type: 'code',
      scope: this.config.getOrThrow<string>('GOOGLE_SCOPES'),
      access_type: 'offline',
      prompt: 'consent',
    }).toString();

    return url.toString();
  }

  /** Exchanges the auth code for tokens and stores the connected account. */
  async handleGoogleCallback(code: string): Promise<{ email: string }> {
    if (!code) {
      throw new BadRequestException('Missing authorization code');
    }

    const oauth2 = new google.auth.OAuth2(
      this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      this.config.getOrThrow<string>('GOOGLE_REDIRECT_URI'),
    );

    try {
      const { tokens } = await withTimeout(
        oauth2.getToken(code),
        GOOGLE_REQUEST_TIMEOUT_MS,
      );
      if (!tokens.access_token) {
        throw new BadRequestException('No access token returned by Google');
      }
      oauth2.setCredentials(tokens);

      const profile = await withTimeout(
        google
          .gmail({ version: GMAIL_API_VERSION, auth: oauth2 })
          .users.getProfile({ userId: GMAIL_SELF_USER }),
        GOOGLE_REQUEST_TIMEOUT_MS,
      );
      const email = profile.data.emailAddress;
      if (!email) {
        throw new BadRequestException('Could not resolve account email');
      }

      const encryptedRefresh = tokens.refresh_token
        ? this.crypto.encrypt(tokens.refresh_token)
        : undefined;

      // Only write refreshToken/scope when Google returns them, so a
      // re-connect that omits them keeps the previously stored values.
      const account = {
        accessToken: this.crypto.encrypt(tokens.access_token),
        tokenExpiresAt: tokens.expiry_date
          ? new Date(tokens.expiry_date)
          : null,
        status: 'connected',
        ...(encryptedRefresh ? { refreshToken: encryptedRefresh } : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      };

      const connectedAccount = await this.prisma.connectedAccount.upsert({
        where: { email },
        create: {
          email,
          scope:
            tokens.scope ?? this.config.getOrThrow<string>('GOOGLE_SCOPES'),
          ...account,
        },
        update: account,
      });
      
      this.eventEmitter.emit('google.account.connected', {
        id: connectedAccount.id,
        email: connectedAccount.email,
      });

      this.logger.log(`Gmail account connected: ${email}`);
      return { email };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(
        `Google OAuth callback failed: ${describeOAuthError(error)}`,
      );
      throw new BadRequestException('Google authentication failed');
    }
  }

  public async getUserCredentials(email: string): Promise<{
    access_token: string;
    refresh_token?: string;
    expiry_date?: number; 
  }> {
    const account = await this.prisma.connectedAccount.findUnique({
      where: { email },
    });
    if (!account) {
      throw new NotFoundException('No connected account found for user');
    }

    return {
      access_token: this.crypto.decrypt(account.accessToken),
      refresh_token: account.refreshToken
        ? this.crypto.decrypt(account.refreshToken)
        : undefined,
      expiry_date: account.tokenExpiresAt ? account.tokenExpiresAt.getTime() : undefined,
    };
  }
}
