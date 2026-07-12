import { Module } from '@nestjs/common';
import { AllowlistService } from './allowlist.service';
import { EmailNotifyModule } from '../email-notify/email-notify.module';

@Module({
  imports: [EmailNotifyModule],
  providers: [AllowlistService],
  exports: [AllowlistService],
})
export class AllowlistModule {}
