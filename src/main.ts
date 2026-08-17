import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import fastifyCookie from '@fastify/cookie';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifyMultipart from '@fastify/multipart';
import { Logger } from 'nestjs-pino';
import { setupGracefulShutdown } from 'nestjs-graceful-shutdown';
import { AppModule } from './app.module';
import { setupSwagger } from './config/swagger';

/**
 * Keep one background failure from taking the whole API down.
 *
 * LangGraph's Postgres checkpointer writes concurrently with node execution
 * and does not await the write, so when `PostgresSaver.put` rejects — a
 * network blip, a database restart, a full disk — nothing is holding the
 * promise. Node's default for an unhandled rejection is to throw, so the
 * process died. This was observed three times: ENETUNREACH to the database,
 * and twice on `could not extend file ... No space left on device`.
 *
 * A checkpoint that failed to persist is bad, but it is one request's problem.
 * Logging it loudly and staying up is strictly better than dropping every
 * other in-flight request and refusing new ones until someone notices.
 *
 * `uncaughtException` is not the same case: by then the process state may be
 * inconsistent, so the only safe move is to log the cause — which today is
 * lost entirely — and let the supervisor restart us.
 */
function installProcessErrorHandlers(logger: Logger): void {
  process.on('unhandledRejection', (reason) => {
    logger.error(
      reason instanceof Error ? reason.stack : String(reason),
      'UnhandledRejection',
    );
  });

  process.on('uncaughtException', (error) => {
    logger.error(error.stack ?? error.message, 'UncaughtException');
    process.exit(1);
  });
}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    {
      bufferLogs: true,
      rawBody: true,
    },
  );

  // Route all framework logs through pino (structured JSON in prod).
  const logger = app.get(Logger);
  app.useLogger(logger);

  installProcessErrorHandlers(logger);

  // Wire signal handling + Nest shutdown hooks for graceful termination.
  setupGracefulShutdown({ app });

  // Secure HTTP response headers.
  await app.register(helmet);

  // Cookie parsing — required for HttpOnly session cookies and CSRF tokens.
  await app.register(fastifyCookie, {
    secret: process.env.COOKIE_SECRET ?? 'dev-cookie-secret-change-me',
  });

  // CSRF token issuance. Enforcement is applied per-route in feature modules,
  // NOT globally: external webhooks (Gmail, HubSpot) cannot carry a CSRF token.
  await app.register(fastifyCsrf);

  // Multipart uploads for the knowledge base. 25MB per-file cap; the
  // controller catches the limit error and returns 400.
  await app.register(fastifyMultipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });

  // CORS for the admin dashboard SPA and Gmail add-on, with cookie credentials.
  // Methods must be explicit — the default omits DELETE/PATCH/PUT, which
  // silently fails browser preflight for deletes, gap-resolve, offboard, etc.
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Strict global validation: strip unknown fields and reject them outright,
  // which also blocks mass-assignment attacks. Transform payloads to DTO types.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // OpenAPI docs at /docs (UI) and /docs-json (spec consumed by Orval).
  setupSwagger(app);

  const port = process.env.PORT ?? 3000;
  // Bind to 0.0.0.0 so the server is reachable from outside the container.
  await app.listen(port, '0.0.0.0');
}
void bootstrap();
