import { Module } from '@nestjs/common';
import { GmailParserService } from '@/email/gmail/gmail-parser.service';
import { GmailProvider } from '@/email/gmail/gmail-provider.service';
import { GmailClientFactory } from '@/email/gmail/gmail-client.factory';
import { GmailWebhookController } from '@/email/gmail/webhook/gmail-webhook.controller';
import { GmailWebhookService } from '@/email/gmail/webhook/gmail-webhook.service';
import { AuthModule } from '@/modules/auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [GmailWebhookController],
  providers: [
    GmailParserService,
    GmailProvider,
    GmailClientFactory,
    GmailWebhookService,
  ],
  exports: [GmailProvider, GmailWebhookService],
})
export class GmailModule {}
