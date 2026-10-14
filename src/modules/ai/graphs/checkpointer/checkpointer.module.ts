import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store';
import { CHECKPOINTER_TOKEN, STORE_TOKEN } from './checkpointer.constants';

@Global()
@Module({
  providers: [
    {
      provide: CHECKPOINTER_TOKEN,
      useFactory: async (configService: ConfigService) => {
        const dbUrl = configService.getOrThrow<string>('DATABASE_URL');
        const saver = PostgresSaver.fromConnString(dbUrl);
        await saver.setup();
        return saver;
      },
      inject: [ConfigService],
    },
    {
      provide: STORE_TOKEN,
      useFactory: async (configService: ConfigService) => {
        const dbUrl = configService.getOrThrow<string>('DATABASE_URL');
        const store = PostgresStore.fromConnString(dbUrl);
        await store.setup();
        return store;
      },
      inject: [ConfigService],
    },
  ],
  exports: [CHECKPOINTER_TOKEN, STORE_TOKEN],
})
export class CheckpointerModule {}
