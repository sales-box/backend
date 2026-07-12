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
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { GoogleCallbackDto } from './dto/google-callback.dto';
import { SeLoginDto } from './dto/se-login.dto';

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
      'Redirect to the dashboard with ?status=connected on success, or ?status=error&retry=1 on failure',
  })
  async googleCallback(
    @Query() query: GoogleCallbackDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ url: string; statusCode: number }> {
    const dashboard = this.config.getOrThrow<string>('FRONTEND_DASHBOARD_URL');

    // One-shot: the state cookie is consumed whether the flow succeeds or not.
    const cookieState = this.consumeStateCookie(req, reply);

    if (query.error || !query.code) {
      return this.redirect(dashboard, 'error');
    }

    // Reject forged callbacks before exchanging the code (login CSRF).
    if (!this.statesMatch(cookieState, query.state)) {
      return this.redirect(dashboard, 'error');
    }

    try {
      await this.authService.handleGoogleCallback(query.code);
      return this.redirect(dashboard, 'connected');
    } catch {
      return this.redirect(dashboard, 'error');
    }
  }

  @Post('se/login')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    description: 'Returns a JWT for an allowlisted Sales Engineer',
  })
  async seLogin(@Body() dto: SeLoginDto): Promise<{ token: string }> {
    const result = await this.authService.seLoginWithGoogle(dto.code);
    if ('error' in result) {
      // 403 with { error: 'invalid_allowlist' } so the extension shows "Invalid"
      // instead of a generic failure.
      throw new ForbiddenException(result);
    }
    return result;
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

  private redirect(
    dashboard: string,
    status: 'connected' | 'error',
  ): { url: string; statusCode: number } {
    const url = new URL(dashboard);
    url.searchParams.set('status', status);
    if (status === 'error') {
      url.searchParams.set('retry', '1');
    }
    return { url: url.toString(), statusCode: HttpStatus.FOUND };
  }
}
