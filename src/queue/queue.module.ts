import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter } from '@bull-board/fastify';
import { BullBoardModule } from '@bull-board/nestjs';

@Module({
  imports: [
    // Shared BullMQ connection to Redis for all queues.
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const password = config.get<string>('REDIS_PASSWORD');
        return {
          connection: {
            host: config.get<string>('REDIS_HOST'),
            port: config.get<number>('REDIS_PORT'),
            ...(password ? { password } : {}),
          },
        };
      },
    }),
    // Bull Board dashboard mounted at /admin/queues (Fastify adapter). The
    // real queues register themselves through BullBoardModule.forFeature in
    // their own modules: classifier, embeddings and kb-quality.
    //
    // Access is gated in main.ts by QUEUE_DASHBOARD_TOKEN — the board exposes
    // every job payload and a retry button, and it used to answer 200 to any
    // anonymous caller.
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: FastifyAdapter,
    }),
  ],
})
export class QueueModule {}
