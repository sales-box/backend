import { Module } from '@nestjs/common';
import { ClassifierModule } from './classifier/classifier.module';
import { AttachmentsModule } from '@/modules/attachments/attachments.module';
import { AiController } from '@/modules/ai/ai.controller';
import { ReplyService } from '@/modules/ai/graphs/reply/reply.service';
import { AiModelService } from '@/modules/ai/ai.model.service';

@Module({
  imports: [ClassifierModule, AttachmentsModule],
  controllers: [AiController],
  providers: [AiModelService, ReplyService],
  // Exported so the embeddings worker can reuse embedDocuments().
  exports: [AiModelService],
})
export class AiModule {}
