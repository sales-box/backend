import { Module } from '@nestjs/common';
import { ClassifierModule } from './classifier/classifier.module';
import { AiController } from '@/modules/ai/ai.controller';
import { ReplyService } from '@/modules/ai/graphs/reply/reply.service';
import { AiModelService } from '@/modules/ai/ai.model.service';

@Module({
  imports: [ClassifierModule],
  controllers: [AiController],
  providers: [AiModelService, ReplyService],
})
export class AiModule {}
