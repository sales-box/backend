import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardModule } from '@bull-board/nestjs';
import { GmailModule } from '../../email/gmail/gmail.module';
import { CLASSIFIER_QUEUE } from './classifier.constants';
import { ClassifierLlmClient } from './classifier-llm-client.adapter';
import { ClassifierProcessor } from './classifier.processor';
import { ClassifierService } from './classifier.service';
import { LLM_CLIENT } from './llm-client.port';

@Module({
  imports: [
    // Shares the root BullMQ Redis connection configured in QueueModule
    // (same pattern as CrmModule).
    BullModule.registerQueue({ name: CLASSIFIER_QUEUE }),
    BullBoardModule.forFeature({
      name: CLASSIFIER_QUEUE,
      adapter: BullMQAdapter,
    }),
    GmailModule,
  ],
  providers: [
    ClassifierService,
    ClassifierProcessor,
    // Real LLM: adapter over the shared LlmClientService (Nagy's LlmModule is
    // @Global, so LlmClientService injects without importing it here).
    { provide: LLM_CLIENT, useClass: ClassifierLlmClient },
  ],
  exports: [ClassifierService],
})
export class ClassifierModule {}
