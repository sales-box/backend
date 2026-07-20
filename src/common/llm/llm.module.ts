import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { LlmClientService } from './llm-client.service';
import { LlmKeyRotator } from './llm-key-rotator.service';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return new Redis({
          host: config.get<string>('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT'),
        });
      },
    },
    LlmKeyRotator,
    LlmClientService,
  ],
  exports: ['REDIS_CLIENT', LlmKeyRotator, LlmClientService],
})
export class LlmModule {}
