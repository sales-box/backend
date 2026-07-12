import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { PrismaService } from '../../database/prisma.service';
import { withTimeout } from '../../common/with-timeout';
import { CryptoService } from './crypto.service';
import { describeOAuthError } from './oauth-error.util';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AllowlistService } from '../allowlist/allowlist.service';
import { TokenService } from './token.service';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GMAIL_API_VERSION = 'v1';
const GMAIL_SELF_USER = 'me';
const GOOGLE_REQUEST_TIMEOUT_MS = 10_000;

type GoogleTokens = {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string | null;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly allowlistService: AllowlistService,
    private readonly eventEmitter: EventEmitter2,
    private readonly tokenService: TokenService,
  ) {}

  buildGoogleAuthUrl(state?: string): string {
    const url = new URL(GOOGLE_AUTH_ENDPOINT);

    url.search = new URLSearchParams({
      client_id: this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      redirect_uri: this.config.getOrThrow<string>('GOOGLE_REDIRECT_URI'),
      response_type: 'code',
      scope: this.config.getOrThrow<string>('GOOGLE_SCOPES'),
      access_type: 'offline',
      prompt: 'consent',
      // CSRF protection: echoed back by Google and verified on the callback.
      ...(state ? { state } : {}),
    }).toString();

    return url.toString();
  }

  /**
   * Exchanges a Google OAuth code for tokens and resolves the account email.
   * Shared by the Admin callback and SE login, so the Google-facing logic lives
   * in one place.
   */
  private async exchangeCodeForEmail(
    code: string,
  ): Promise<{ email: string; tokens: GoogleTokens }> {
    if (!code) {
      throw new BadRequestException('Missing authorization code');
    }

    const oauth2 = new google.auth.OAuth2(
      this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      this.config.getOrThrow<string>('GOOGLE_REDIRECT_URI'),
    );

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

    return { email, tokens };
  }

  /** Builds the encrypted account row and upserts the ConnectedAccount. */
  private async upsertConnectedAccount(email: string, tokens: GoogleTokens) {
    if (!tokens.access_token) {
      throw new BadRequestException('No access token returned by Google');
    }

    const encryptedRefresh = tokens.refresh_token
      ? this.crypto.encrypt(tokens.refresh_token)
      : undefined;

    // Only write refreshToken/scope when Google returns them, so a re-connect
    // that omits them keeps the previously stored values.
    const account = {
      accessToken: this.crypto.encrypt(tokens.access_token),
      tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      status: 'connected',
      ...(encryptedRefresh ? { refreshToken: encryptedRefresh } : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
    };

    // TODO (Role 3 - Mohamed): scope by [tenantId, email] once OAuth state
    // carries tenantId, and set isAdmin for the first account per tenant.
    const existing = await this.prisma.connectedAccount.findFirst({
      where: { email },
    });

    if (existing) {
      return this.prisma.connectedAccount.update({
        where: { id: existing.id },
        data: account,
      });
    }
    return this.prisma.connectedAccount.create({
      data: {
        email,
        scope: tokens.scope ?? this.config.getOrThrow<string>('GOOGLE_SCOPES'),
        ...account,
      },
    });
  }

  /**
   * Admin OAuth callback: connects the admin's Gmail and rejects any email not
   * on a tenant allowlist. Redirect-based flow — returns only the email; the
   * controller redirects to the dashboard.
   */
  async handleGoogleCallback(code: string): Promise<{ email: string }> {
    try {
      const { email, tokens } = await this.exchangeCodeForEmail(code);

      // Reject sign-in for any email not on an allowlist, even if Google approved.
      await this.allowlistService.verifyAccess(email);

      const connectedAccount = await this.upsertConnectedAccount(email, tokens);

      this.eventEmitter.emit('google.account.connected', {
        id: connectedAccount.id,
        email: connectedAccount.email,
      });

      this.logger.log(`Gmail account connected: ${email}`);
      return { email };
    } catch (error) {
      // Re-throw any deliberate HTTP error (BadRequest, Forbidden, ...) as-is;
      // BadRequestException is itself an HttpException, so this covers it.
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(
        `Google OAuth callback failed: ${describeOAuthError(error)}`,
      );
      throw new BadRequestException('Google authentication failed');
    }
  }

  /**
   * SE login from the Gmail extension. Reuses the Google code-exchange, requires
   * the email to be on an allowlist, then returns a signed JWT. Returns JSON
   * (never redirects). A non-allowlisted email yields a clear
   * { error: 'invalid_allowlist' } rather than a generic failure.
   */
  async seLoginWithGoogle(
    code: string,
  ): Promise<{ token: string } | { error: 'invalid_allowlist' }> {
    const { email, tokens } = await this.exchangeCodeForEmail(code);

    try {
      await this.allowlistService.verifyAccess(email);
    } catch (error) {
      if (error instanceof ForbiddenException) {
        return { error: 'invalid_allowlist' };
      }
      throw error;
    }

    await this.upsertConnectedAccount(email, tokens);
    return { token: this.tokenService.issueSeToken({ email }) };
  }

  public async getUserCredentials(email: string): Promise<{
    access_token: string;
    refresh_token?: string;
    expiry_date?: number;
  }> {
    // const account = await this.prisma.connectedAccount.findUnique({
    //   where: { email },
    // });

    // TODO (Role 3 - Mohamed): Temporary fix for DEP-1. Replace findFirst with findUnique using composite key [tenantId, email].
    const account = await this.prisma.connectedAccount.findFirst({
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
      expiry_date: account.tokenExpiresAt
        ? account.tokenExpiresAt.getTime()
        : undefined,
    };
  }
}
