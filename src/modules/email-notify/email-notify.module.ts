import { Module } from '@nestjs/common';
import { EmailNotifyService } from './email-notify.service';

@Module({
  providers: [EmailNotifyService],
  exports: [EmailNotifyService],
})
export class EmailNotifyModule {}
