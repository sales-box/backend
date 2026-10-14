import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardModule } from '@bull-board/nestjs';
import { AiModule } from '../ai/ai.module';
import { EmbeddingsProcessor } from './embeddings.processor';
import { EMBEDDINGS_QUEUE } from './embeddings.constants';
import { QUALITY_QUEUE } from '../knowledge-base/quality/quality.constants';

@Module({
  imports: [
    // Shares the root BullMQ Redis connection configured in QueueModule.
    BullModule.registerQueue({ name: EMBEDDINGS_QUEUE }),
    // Producer side: this worker enqueues a quality job when embeddings finish
    // (the QualityProcessor consumer lives in QualityModule).
    BullModule.registerQueue({ name: QUALITY_QUEUE }),
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
