import { Module } from '@nestjs/common';
import { ClassifierModule } from './classifier/classifier.module';
import { SupervisorModule } from './supervisor/supervisor.module';
import { AttachmentsModule } from '@/modules/attachments/attachments.module';
import { ClientsModule } from '@/modules/clients/clients.module';
import { GmailModule } from '@/modules/email/gmail/gmail.module';
import { AiController } from '@/modules/ai/ai.controller';
import { ReplyService } from '@/modules/ai/graphs/reply/reply.service';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { AuthModule } from '@/modules/auth/auth.module';
import { BackfillThreadIdService } from './backfill/backfill-thread-id.service';
import { AiAdminController } from './backfill/ai-admin.controller';

@Module({
  imports: [
    ClassifierModule,
    SupervisorModule,
    AttachmentsModule,
    ClientsModule,
    GmailModule,
    AuthModule,
  ],
  controllers: [AiController, AiAdminController],
  providers: [ReplyService, AiOrchestratorService, BackfillThreadIdService],
  exports: [],
})
export class AiModule {}
