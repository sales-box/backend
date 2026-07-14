import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { GmailParserService } from '@/modules/email/gmail/gmail-parser.service';
import { GmailProvider } from '@/modules/email/gmail/gmail-provider.service';
import { GmailClientFactory } from '@/modules/email/gmail/gmail-client.factory';
import { GmailWebhookController } from '@/modules/email/gmail/webhook/gmail-webhook.controller';
import { GmailWebhookService } from '@/modules/email/gmail/webhook/gmail-webhook.service';
import { AuthModule } from '@/modules/auth/auth.module';
import { CLASSIFIER_QUEUE } from '@/modules/ai/classifier/classifier.constants';

@Module({
  imports: [
    AuthModule,
    // Producer-side registration of the classifier queue (the worker lives in
    // ClassifierModule). Only the constant is imported from the classifier
    // folder — no DI dependency, so no module cycle. Bull Board registration
    // for this queue stays in ClassifierModule (must exist exactly once).
    BullModule.registerQueue({ name: CLASSIFIER_QUEUE }),
  ],
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
