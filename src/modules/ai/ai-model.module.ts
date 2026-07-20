import { Global, Module } from '@nestjs/common';
import { AiModelService } from './ai.model.service';

@Global()
@Module({
  providers: [AiModelService],
  exports: [AiModelService],
})
export class AiModelModule {}
