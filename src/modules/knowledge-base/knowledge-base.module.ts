import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeBaseController } from './knowledge-base.controller';
import { KnowledgeBaseService } from './knowledge-base.service';
import { KbSearchService } from './kb-search.service';
import { EMBEDDINGS_QUEUE } from '../embeddings/embeddings.constants';

@Module({
  // AuthModule provides JwtAuthGuard (admin JWT → tenant identity).
  // Embeddings queue: the service enqueues a job after each upload so new
  // chunks are embedded in the background (worker lives in EmbeddingsModule).
  //
  // KbSearchService needs PrismaService and AiModelService; both live in
  // @Global modules, so no extra import is required here — and notably NOT
  // AiModule, which would drag in langgraph and the checkpointer for nothing.
  imports: [AuthModule, BullModule.registerQueue({ name: EMBEDDINGS_QUEUE })],
  controllers: [KnowledgeBaseController],
  providers: [KnowledgeBaseService, KbSearchService],
  exports: [KnowledgeBaseService],
})
export class KnowledgeBaseModule {}
