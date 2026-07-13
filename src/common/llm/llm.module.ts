import { Global, Module } from '@nestjs/common';
import { LlmClientService } from './llm-client.service';

@Global()
@Module({
  providers: [LlmClientService],
  exports: [LlmClientService],
})
export class LlmModule {}
