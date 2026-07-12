import { Module } from '@nestjs/common';
import { AllowlistService } from './allowlist.service';
import { EmailNotifyModule } from '../email-notify/email-notify.module';
import { AllowlistController } from './allowlist.controller';

@Module({
  imports: [EmailNotifyModule],
  providers: [AllowlistService],
  exports: [AllowlistService],
  controllers: [AllowlistController],
})
export class AllowlistModule {}
