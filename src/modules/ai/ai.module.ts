import { Module } from '@nestjs/common';
import { ClassifierModule } from './classifier/classifier.module';
import { SupervisorModule } from './supervisor/supervisor.module';
import { AttachmentsModule } from '@/modules/attachments/attachments.module';
import { ClientsModule } from '@/modules/clients/clients.module';
import { GmailModule } from '@/modules/email/gmail/gmail.module';
import { AiController } from '@/modules/ai/ai.controller';
import { ReplyService } from '@/modules/ai/graphs/reply/reply.service';
import { AiModelService } from '@/modules/ai/ai.model.service';
import { AiOrchestratorService } from './ai-orchestrator.service';

@Module({
  imports: [
    ClassifierModule,
    SupervisorModule,
    AttachmentsModule,
    ClientsModule,
    GmailModule,
  ],
  controllers: [AiController],
  providers: [AiModelService, ReplyService, AiOrchestratorService],
})
export class AiModule {}
