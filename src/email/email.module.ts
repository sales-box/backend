import { Module } from '@nestjs/common';
import { GmailModule } from '@/email/gmail/gmail.module';
import { EmailService } from '@/email/email.service';
import { EmailProvider } from '@/email/email-provider.abstract';
import { GmailProvider } from '@/email/gmail/gmail-provider.service';

@Module({
  imports: [GmailModule],
  providers: [
    EmailService,
    {
      provide: EmailProvider,
      useExisting: GmailProvider,
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
