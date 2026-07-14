import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Redirect,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { GoogleCallbackDto } from './dto/google-callback.dto';
import { SeLoginDto } from './dto/se-login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { AuthenticatedRequest } from './jwt-auth.guard';
import type { AdminJwtPayload } from './admin-auth.service';
import { TenantAllowlistGuard } from '../allowlist/tenant-allowlist.guard';

/** Cookie carrying the OAuth CSRF state between /auth/google and the callback. */
const OAUTH_STATE_COOKIE = 'oauth_state';
const OAUTH_STATE_TTL_SECONDS = 600; // 10 minutes to finish the consent screen

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Get('google')
  @Redirect()
  @ApiFoundResponse({
    description: 'Redirect to the Google OAuth consent screen',
  })
  googleAuth(@Res({ passthrough: true }) reply: FastifyReply): {
    url: string;
    statusCode: number;
  } {
    // CSRF protection: random state stored in a signed HttpOnly cookie and
    // verified against the ?state Google echoes back on the callback.
    const state = randomBytes(16).toString('hex');
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      signed: true,
      path: '/auth',
      maxAge: OAUTH_STATE_TTL_SECONDS,
      secure: process.env.NODE_ENV === 'production',
    });

    return {
      url: this.authService.buildGoogleAuthUrl(state),
      statusCode: HttpStatus.FOUND,
    };
  }

  @Get('google/callback')
  @Redirect()
  @ApiFoundResponse({
    description:
      'Redirect to the dashboard /callback page: ?token=&tenantId= for an ' +
      'established admin (Google acts as a login), ?status=connected for a ' +
      'first-time connect, or ?status=error&retry=1 on failure',
  })
  async googleCallback(
    @Query() query: GoogleCallbackDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ url: string; statusCode: number }> {
    // One-shot: the state cookie is consumed whether the flow succeeds or not.
    const cookieState = this.consumeStateCookie(req, reply);

    if (query.error || !query.code) {
      return this.redirect({ status: 'error', retry: '1' });
    }

    // Reject forged callbacks before exchanging the code (login CSRF).
    if (!this.statesMatch(cookieState, query.state)) {
      return this.redirect({ status: 'error', retry: '1' });
    }

    try {
      const result = await this.authService.handleGoogleCallback(query.code);
      // Established admin: hand the session token to the SPA. Otherwise it is
      // a first-time connect — the SPA routes the user to set-password.
      if (result.adminToken && result.tenantId) {
        return this.redirect({
          token: result.adminToken,
          tenantId: result.tenantId,
        });
      }
      return this.redirect({ status: 'connected' });
    } catch {
      return this.redirect({ status: 'error', retry: '1' });
    }
  }

  @Post('se/login')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    description: 'Returns a JWT for an allowlisted Sales Engineer',
  })
  async seLogin(@Body() dto: SeLoginDto): Promise<{ token: string }> {
    const result = await this.authService.seLoginWithGoogle(
      dto.code,
      dto.redirectUri,
    );
    if ('error' in result) {
      // 403 with { error: 'invalid_allowlist' } so the extension shows "Invalid"
      // instead of a generic failure.
      throw new ForbiddenException(result);
    }
    return result;
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({
    description: 'The identity carried by the caller’s JWT (admin or SE)',
  })
  me(@Req() req: AuthenticatedRequest): AdminJwtPayload {
    // Whoami: the dashboard and the extension both call this to confirm the
    // token is still valid and to read { tenantId, isAdmin, email }.
    return req.user;
  }

  @Get('se/session')
  @UseGuards(TenantAllowlistGuard)
  @ApiBearerAuth()
  @ApiOkResponse({
    description:
      'SE heartbeat: 200 only while the account is still connected, so the ' +
      'extension detects a revoke/offboard even before the token expires',
  })
  seSession(@Req() req: AuthenticatedRequest): AdminJwtPayload {
    // Unlike /auth/me (token-only), TenantAllowlistGuard also checks the account
    // is still `connected`, turning this into a revocation-aware session check.
    return req.user;
  }

  /** Unsigns and clears the state cookie; returns its value when intact. */
  private consumeStateCookie(
    req: FastifyRequest,
    reply: FastifyReply,
  ): string | undefined {
    const raw = req.cookies[OAUTH_STATE_COOKIE];
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth' });
    if (!raw) {
      return undefined;
    }
    const unsigned = req.unsignCookie(raw);
    return unsigned.valid && unsigned.value ? unsigned.value : undefined;
  }

  private statesMatch(expected?: string, received?: string): boolean {
    if (!expected || !received || expected.length !== received.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  }

  /**
   * Builds the SPA /callback redirect. The target origin comes ONLY from
   * FRONTEND_DASHBOARD_URL config — never from a caller-supplied redirect
   * param, which would be an open redirect leaking tokens to arbitrary URLs.
   */
  private redirect(params: Record<string, string>): {
    url: string;
    statusCode: number;
  } {
    const dashboard = this.config.getOrThrow<string>('FRONTEND_DASHBOARD_URL');
    const url = new URL('/callback', new URL(dashboard).origin);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return { url: url.toString(), statusCode: HttpStatus.FOUND };
  }
}
