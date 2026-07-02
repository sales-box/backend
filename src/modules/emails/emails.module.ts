import { Module } from '@nestjs/common';
import { EmailsController } from './emails.controller';
import { EmailsService } from './emails.service';
import { AuthModule } from '../auth/auth.module';
import { GmailClientProvider } from './gmail-client.provider';
import { GmailPollingService } from './gmail-polling.service';

@Module({
  imports: [AuthModule],
  controllers: [EmailsController],
  providers: [EmailsService, GmailClientProvider, GmailPollingService],
  exports: [EmailsService],
})
export class EmailsModule {}
