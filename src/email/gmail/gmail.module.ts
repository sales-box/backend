import { Module } from '@nestjs/common';
import { GmailParserService } from '@/email/gmail/gmail-parser.service';
import { GmailProvider } from '@/email/gmail/gmail-provider.service';
import { GmailClientFactory } from '@/email/gmail/gmail-client.factory';
import { GmailWebhookController } from '@/email/gmail/webhook/gmail-webhook.controller';
import { GmailWebhookService } from './webhook/gmail-webhook.service';

@Module({
  controllers: [GmailWebhookController],
  providers: [
    GmailParserService,
    GmailProvider,
    GmailClientFactory,
    GmailWebhookService,
  ],
  exports: [GmailProvider],
})
export class GmailModule {}
