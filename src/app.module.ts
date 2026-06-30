import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { createKeyv } from '@keyv/redis';
import { Redis } from 'ioredis';
import { LoggerModule } from 'nestjs-pino';
import { GracefulShutdownModule } from 'nestjs-graceful-shutdown';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './database/prisma.module';
import { QueueModule } from './queue/queue.module';
import { HealthModule } from './modules/health/health.module';
import { EmailsModule } from './modules/emails/emails.module';

const isProd = process.env.NODE_ENV === 'production';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    // Drain in-flight requests and close DB/Redis cleanly on SIGTERM/SIGINT.
    GracefulShutdownModule.forRoot({
      gracefulShutdownTimeout: 10_000,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
        // Human-readable logs in dev; structured JSON in production.
        transport: isProd
          ? undefined
          : { target: 'pino-pretty', options: { singleLine: true } },
        // Never leak credentials into logs.
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
      },
    }),
    // Redis-backed cache (Keyv store). Global so any module can inject CACHE_MANAGER.
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        stores: [
          createKeyv(
            `redis://${config.get<string>('REDIS_HOST')}:${config.get<number>('REDIS_PORT')}`,
          ),
        ],
        ttl: 30_000,
      }),
    }),
    // Rate limiting backed by Redis so limits are shared across all instances.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('THROTTLE_TTL', 60_000),
            limit: config.get<number>('THROTTLE_LIMIT', 100),
          },
        ],
        storage: new ThrottlerStorageRedisService(
          new Redis({
            host: config.get<string>('REDIS_HOST'),
            port: config.get<number>('REDIS_PORT'),
          }),
        ),
      }),
    }),
    PrismaModule,
    QueueModule,
    HealthModule,
    EmailsModule,
    UsersModule,
  ],
  providers: [
    // Apply rate limiting globally.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
