import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { BullBoardModule } from '@bull-board/nestjs';
import { DemoController } from './demo.controller';
import { DemoProcessor } from './demo.processor';
import { DEMO_QUEUE } from './queue.constants';

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
    BullModule.registerQueue({ name: DEMO_QUEUE }),
    // Bull Board dashboard mounted at /admin/queues (Fastify adapter).
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: FastifyAdapter,
    }),
    BullBoardModule.forFeature({ name: DEMO_QUEUE, adapter: BullMQAdapter }),
  ],
  controllers: [DemoController],
  providers: [DemoProcessor],
})
export class QueueModule {}
