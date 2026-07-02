import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/** Validates that a key decodes (base64 or hex) to exactly 32 bytes. */
@ValidatorConstraint({ name: 'is32ByteKey', async: false })
export class Is32ByteKeyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0) return false;
    const buf = /^[0-9a-fA-F]{64}$/.test(value)
      ? Buffer.from(value, 'hex')
      : Buffer.from(value, 'base64');
    return buf.length === 32;
  }

  defaultMessage(): string {
    return 'TOKEN_ENCRYPTION_KEY must decode (base64 or hex) to exactly 32 bytes';
  }
}

/**
 * Schema for all environment variables the app depends on.
 * Validated once at boot — a missing/invalid var fails fast instead of
 * surfacing as a confusing runtime error later.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(0)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;

  @IsString()
  REDIS_HOST: string = 'localhost';

  @IsInt()
  @Min(0)
  @Max(65535)
  REDIS_PORT: number = 6379;

  @IsString()
  @MinLength(16)
  COOKIE_SECRET!: string;

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  // Rate limiting: requests per TTL window (ms), shared across instances via Redis.
  @IsInt()
  @Min(1)
  THROTTLE_TTL: number = 60_000;

  @IsInt()
  @Min(1)
  THROTTLE_LIMIT: number = 100;

  // ----- Google OAuth (Gmail) -----

  @IsString()
  @MinLength(1)
  GOOGLE_CLIENT_ID!: string;

  @IsString()
  @MinLength(1)
  GOOGLE_CLIENT_SECRET!: string;

  @IsUrl({ require_tld: false })
  GOOGLE_REDIRECT_URI!: string;

  @IsString()
  @MinLength(1)
  GOOGLE_SCOPES!: string;

  // ----- Token encryption / frontend -----

  @Validate(Is32ByteKeyConstraint)
  TOKEN_ENCRYPTION_KEY!: string;

  @IsUrl({ require_tld: false })
  FRONTEND_DASHBOARD_URL!: string;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors
      .map((e) => Object.values(e.constraints ?? {}).join(', '))
      .join('\n  - ');
    throw new Error(`Environment validation failed:\n  - ${details}`);
  }

  return validated;
}
