import { Injectable } from '@nestjs/common';
import { GmailClientFactory } from '@/email/gmail/gmail-client.factory';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class GmailWebhookService {
  private readonly topicName: string;

  constructor(
    private readonly gmailClientFactory: GmailClientFactory,
    private readonly config: ConfigService,
  ) {
    this.topicName = this.config.getOrThrow<string>('GOOGLE_PUBSUB_TOPIC_NAME');
  }

  async subscribeToTopic(emailAccountId: string): Promise<void> {
    const gmailClient =
      await this.gmailClientFactory.createClient(emailAccountId);

    const response = await gmailClient.users.watch({
      userId: 'me',
      requestBody: {
        topicName: this.topicName,
        labelIds: ['INBOX', 'SENT'],
        labelFilterBehavior: 'include',
      },
    });

    console.log(
      `Subscribed to Gmail Pub/Sub topic for account ${emailAccountId}:`,
      response.data,
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  renewSubscriptions(): void {
    console.log('Renewing Gmail Pub/Sub subscriptions for all accounts...');
  }
}
