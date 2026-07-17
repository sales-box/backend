import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardModule } from '@bull-board/nestjs';
import { AiModule } from '../ai/ai.module';
import { EmbeddingsProcessor } from './embeddings.processor';
import { EMBEDDINGS_QUEUE } from './embeddings.constants';

@Module({
  imports: [
    // Shares the root BullMQ Redis connection configured in QueueModule.
    BullModule.registerQueue({ name: EMBEDDINGS_QUEUE }),
    BullBoardModule.forFeature({
      name: EMBEDDINGS_QUEUE,
      adapter: BullMQAdapter,
    }),
    // AiModule exports AiModelService (embedDocuments).
    AiModule,
  ],
  providers: [EmbeddingsProcessor],
})
export class EmbeddingsModule {}
