import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

const SE_TOKEN_TTL = '7d';

/**
 * Issues signed JWTs for authenticated users. Uses `jsonwebtoken` directly (the
 * same engine `@nestjs/jwt` wraps) because the wrapper can't be installed in this
 * environment — see src/types/jsonwebtoken.d.ts.
 */
@Injectable()
export class TokenService {
  constructor(private readonly config: ConfigService) {}

  /** Signs a short-lived token for a logged-in Sales Engineer. */
  issueSeToken(payload: { email: string }): string {
    const secret = this.config.getOrThrow<string>('JWT_SECRET');
    return jwt.sign({ email: payload.email, role: 'se' }, secret, {
      expiresIn: SE_TOKEN_TTL,
    });
  }
}
