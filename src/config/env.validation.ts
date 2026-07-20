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
  ValidateIf,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  validateSync,
} from 'class-validator';
import { CrmProvider } from '../modules/crm/crm.constants';

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

  // ----- Google Pub/Sub (Gmail) -----
  @IsString()
  @MinLength(1)
  GOOGLE_PUBSUB_VERIFICATION_TOKEN!: string;

  @IsString()
  @MinLength(1)
  GOOGLE_PUBSUB_TOPIC_NAME!: string;

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

  // ----- JWT (admin login + SE login) -----

  // Signs and verifies every JWT: admin password login, SE login, and the
  // JwtAuthGuard/TenantAllowlistGuard. Dev fallback mirrors the COOKIE_SECRET
  // pattern; production MUST override.
  @IsString()
  @MinLength(32)
  JWT_SECRET: string = 'dev-jwt-secret-change-me-0123456789abcdef';

  @IsString()
  @MinLength(2)
  JWT_EXPIRES_IN: string = '1h';

  // ----- Token encryption / frontend -----

  @Validate(Is32ByteKeyConstraint)
  TOKEN_ENCRYPTION_KEY!: string;

  @IsUrl({ require_tld: false })
  FRONTEND_DASHBOARD_URL!: string;

  @IsUrl({ require_tld: false })
  EXTENSION_INSTALL_URL!: string;

  // ----- CRM (HubSpot) -----

  @IsEnum(CrmProvider)
  CRM_PROVIDER: CrmProvider = CrmProvider.Mock;

  @ValidateIf(
    (env: EnvironmentVariables) => env.CRM_PROVIDER === CrmProvider.HubSpot,
  )
  @IsString()
  @MinLength(1)
  HUBSPOT_API_KEY!: string;

  // ----- Google Drive OAuth (US-043) -----
  // Defaulted so it is never missing; read-only scope for the admin connection.
  @IsString()
  @MinLength(1)
  GOOGLE_DRIVE_SCOPES: string =
    'https://www.googleapis.com/auth/drive.readonly';

  // ----- AWS S3 (US-043 external content storage) -----
  // Required at boot so a missing bucket/region fails fast instead of surfacing
  // as a silent per-link fetch_failed later. AWS credentials come from the
  // default provider chain (env/role), never validated or hardcoded here.
  @IsString()
  @MinLength(1)
  AWS_REGION!: string;

  @IsString()
  @MinLength(1)
  S3_BUCKET!: string;

  // Optional S3-compatible endpoint (e.g. LocalStack) for local dev.
  @IsOptional()
  @IsString()
  S3_ENDPOINT?: string;

  // ----- Email Verification (Nodemailer) -----

  @IsString()
  @MinLength(1)
  SMTP_HOST: string = 'smtp.gmail.com';

  @IsInt()
  @Min(1)
  @Max(65535)
  SMTP_PORT: number = 587;

  @IsString()
  @MinLength(1)
  SMTP_USER!: string;

  @IsString()
  @MinLength(1)
  SMTP_PASS!: string;

  @IsUrl({ require_tld: false })
  API_URL: string = 'http://localhost:3000';

  // ----- LLM (provider-agnostic — OpenAI SDK + configurable baseURL) -----
  // Currently pointed at Groq's OpenAI-compatible endpoint. Swapping
  // providers later (e.g. once ITI issues an OpenAI key) should only
  // require changing these vars, not the client code.
  @IsOptional()
  @IsString()
  LLM_API_KEY?: string;

  @IsString()
  @MinLength(1)
  LLM_API_KEYS!: string;

  @IsUrl({ require_tld: false })
  LLM_BASE_URL!: string;

  @IsString()
  @MinLength(1)
  PORTKEY_API_KEY!: string;

  @IsUrl({ require_tld: false })
  PORTKEY_BASE_URL!: string;

  @IsString()
  @MinLength(1)
  PORTKEY_CONFIG_ID!: string;

  @IsString()
  @MinLength(1)
  LLM_MODEL!: string;

  // Multimodal model for image/attachment analysis (Extractor's vision
  // fallback, Attachments module). Reuses LLM_API_KEY/LLM_BASE_URL —
  // only the model name differs.
  @IsString()
  @MinLength(1)
  VISION_MODEL!: string;

  // ----- Embeddings (separate provider from chat) -----
  // Chat runs on Groq, which serves no /embeddings endpoint, so the
  // embedding provider must be configurable independently. Currently
  // pointed at a local Ollama instance (OpenAI-compatible API).
  @IsString()
  @MinLength(1)
  EMBEDDING_API_KEY!: string;

  @IsUrl({ require_tld: false })
  EMBEDDING_BASE_URL!: string;

  @IsString()
  @MinLength(1)
  EMBEDDING_MODEL!: string;
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
