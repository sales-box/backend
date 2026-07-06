import { Module } from '@nestjs/common';
import { GmailModule } from '@/modules/email/gmail/gmail.module';
import { EmailService } from '@/modules/email/email.service';
import { EmailProvider } from '@/modules/email/email-provider.abstract';
import { GmailProvider } from '@/modules/email/gmail/gmail-provider.service';

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
