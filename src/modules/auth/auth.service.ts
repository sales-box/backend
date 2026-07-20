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
import { JwtService } from '@nestjs/jwt';
import { AllowlistService } from '../allowlist/allowlist.service';
import type { AdminJwtPayload } from './admin-auth.service';

// Sales-Engineer tokens outlive the short-lived admin token (which defaults to
// JWT_EXPIRES_IN) because the extension stays signed in between sessions.
const SE_TOKEN_TTL = '7d';

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
    private readonly jwt: JwtService,
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
    redirectUri?: string,
  ): Promise<{ email: string; tokens: GoogleTokens }> {
    if (!code) {
      throw new BadRequestException('Missing authorization code');
    }

    const oauth2 = new google.auth.OAuth2(
      this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      redirectUri ?? this.config.getOrThrow<string>('GOOGLE_REDIRECT_URI'),
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

  /**
   * Builds the encrypted account row and upserts the ConnectedAccount. When a
   * tenantId is given (SE login, from the allowlist grant) it is written onto the
   * row, so tenant-scoped revoke/offboard can reach this account.
   */
  private async upsertConnectedAccount(
    rawEmail: string,
    tokens: GoogleTokens,
    tenantId?: string,
  ) {
    const email = rawEmail.toLowerCase().trim();
    if (!tokens.access_token) {
      throw new BadRequestException('No access token returned by Google');
    }

    const encryptedRefresh = tokens.refresh_token
      ? this.crypto.encrypt(tokens.refresh_token)
      : undefined;

    // Only write refreshToken/scope when Google returns them, so a re-connect
    // that omits them keeps the previously stored values.
    // lastLoginAt is stamped unconditionally on every call (create AND
    // update) — unlike AllowlistEntry.verifiedAt (set once, on first
    // activation), this is meant to move on every login so the dashboard can
    // show real, current SE activity rather than a one-time badge.
    const account = {
      accessToken: this.crypto.encrypt(tokens.access_token),
      tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      status: 'connected',
      lastLoginAt: new Date(),
      ...(encryptedRefresh ? { refreshToken: encryptedRefresh } : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      ...(tenantId ? { tenantId } : {}),
    };

    // When tenantId is present (SE login path), scope the lookup to the
    // [tenantId, email] composite unique key so the same email under a
    // different tenant is never mistakenly matched or overwritten.
    // When tenantId is absent (admin first-connect via Google OAuth, before a
    // tenant association exists) a plain email lookup is the only option —
    // the row gains a tenantId later when setAdminPassword links identities.
    const existing = tenantId
      ? await this.prisma.connectedAccount.findUnique({
          where: { tenantId_email: { tenantId, email } },
        })
      : await this.prisma.connectedAccount.findFirst({
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
   * Admin OAuth callback: connects the admin's Gmail. Redirect-based flow —
   * the controller turns the result into a dashboard redirect.
   *
   * Returns an adminToken ONLY for an established admin (isAdmin with a
   * password already set): "Continue with Google" is then a real login.
   * A first-time connect returns no token — the account gains privileges
   * later via set-password (tenant active + first-admin rule).
   */
  async handleGoogleCallback(code: string): Promise<{
    email: string;
    adminToken?: string;
    tenantId?: string | null;
  }> {
    try {
      const { email, tokens } = await this.exchangeCodeForEmail(code);

      // Deliberately NOT allowlist-gated: the allowlist is the SE guest list,
      // and the admin is a different trust model (they own the tenant).
      // Connecting Google grants no privileges by itself. SE login
      // (seLoginWithGoogle) stays strictly allowlist-gated.
      const connectedAccount = await this.upsertConnectedAccount(email, tokens);

      this.eventEmitter.emit('google.account.connected', {
        id: connectedAccount.id,
        email: connectedAccount.email,
      });

      this.logger.log(`Gmail account connected: ${email}`);

      // Established admin → mint the same JWT /auth/admin/login issues
      // (module-default TTL), so Google works as a login, not just a connect.
      if (connectedAccount.isAdmin && connectedAccount.passwordHash) {
        const payload: AdminJwtPayload = {
          sub: connectedAccount.id,
          tenantId: connectedAccount.tenantId,
          isAdmin: true,
          email: connectedAccount.email,
        };
        return {
          email,
          adminToken: await this.jwt.signAsync({ ...payload }),
          tenantId: connectedAccount.tenantId,
        };
      }

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
    redirectUri?: string,
  ): Promise<{ token: string } | { error: 'invalid_allowlist' }> {
    let email: string;
    let tokens: GoogleTokens;
    try {
      ({ email, tokens } = await this.exchangeCodeForEmail(code, redirectUri));
    } catch (error) {
      // Catch unhandled Google OAuth code exchange failures and emit a clean 400 rather than raw 500
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(
        `Google OAuth callback failed: ${describeOAuthError(error)}`,
      );
      throw new BadRequestException('Google authentication failed');
    }

    let tenantId: string;
    try {
      // The allowlist grant is the source of truth for which tenant this SE
      // belongs to — stamp it onto the account and token below.
      ({ tenantId } = await this.allowlistService.verifyAccess(email));
    } catch (error) {
      if (error instanceof ForbiddenException) {
        return { error: 'invalid_allowlist' };
      }
      throw error;
    }

    const account = await this.upsertConnectedAccount(email, tokens, tenantId);

    // Register (or refresh) the Gmail Pub/Sub watch subscription for this SE.
    // seLoginWithGoogle is the ONLY path an SE ever connects Google from —
    // unlike the admin dashboard flow (handleGoogleCallback, below), this
    // never fired the event before, so classification silently never
    // started for any SE-only tenant. Mirrors handleGoogleCallback's emit
    // exactly: same event name, same payload shape, same post-upsert
    // timing — account.id here is a real ConnectedAccount.id, which is
    // what subscribeToTopic's webhookSubscription upsert requires.
    this.eventEmitter.emit('google.account.connected', {
      id: account.id,
      email: account.email,
    });

    // Same claim shape as the admin token so a single JwtAuthGuard can verify
    // both. An SE session is never an admin, regardless of the row's isAdmin.
    const payload: AdminJwtPayload = {
      sub: account.id,
      tenantId: account.tenantId,
      isAdmin: false,
      email: account.email,
    };
    return {
      token: await this.jwt.signAsync(payload, { expiresIn: SE_TOKEN_TTL }),
    };
  }

  /**
   * Returns the decrypted OAuth credentials for a connected account.
   *
   * @param email    The account email address.
   * @param tenantId When provided the lookup is scoped to the [tenantId, email]
   *                 composite key, which is safe and correct for all SE / admin
   *                 paths that have a tenant in context.
   *
   * ⚠️  CALL-SITE NOTE for GmailClientFactory.createClient:
   *    That call site currently only has the emailAccount string and no tenantId
   *    available. It passes `undefined` here, so the lookup falls back to a
   *    plain email scan. This is a known gap — threading tenantId through the
   *    gmail-client-factory → gmail-provider → webhook-service chain requires a
   *    larger refactor and should be tracked as a follow-up task (DEP-1 phase 2).
   *    Do NOT silently widen this gap further without a product decision.
   */
  public async getUserCredentials(
    rawEmail: string,
    tenantId?: string,
  ): Promise<{
    access_token: string;
    refresh_token?: string;
    expiry_date?: number;
  }> {
    const email = rawEmail.toLowerCase().trim();
    const account = tenantId
      ? await this.prisma.connectedAccount.findUnique({
          where: { tenantId_email: { tenantId, email } },
        })
      : // Admin-first-connect / gmail-factory path: tenantId not yet available.
        // Falls back to email-only scan. See call-site note above.
        await this.prisma.connectedAccount.findFirst({
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
