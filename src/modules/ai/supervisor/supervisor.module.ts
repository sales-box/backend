import { Module } from '@nestjs/common';
import { SupervisorService } from './supervisor.service';

@Module({
  providers: [SupervisorService],
  exports: [SupervisorService], // so AiModule (PR3) can inject it
})
export class SupervisorModule {}
