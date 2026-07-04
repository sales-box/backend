import { Injectable, Logger } from '@nestjs/common';
import { GmailClientFactory } from '@/email/gmail/gmail-client.factory';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '@/database/prisma.service';
import { OnEvent } from '@nestjs/event-emitter';
@Injectable()
export class GmailWebhookService {
  private readonly logger = new Logger(GmailWebhookService.name);
  private readonly topicName: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gmailClientFactory: GmailClientFactory,
    private readonly config: ConfigService,
  ) {
    this.topicName = this.config.getOrThrow<string>('GOOGLE_PUBSUB_TOPIC_NAME');
  }

  @OnEvent('google.account.connected')
  private async handleGoogleAccountConnected(payload: { id: string; email: string }): Promise<void> {
    this.logger.log(`Detected new Google account connection for ${payload.email}. Initializing Pub/Sub...`);
    await this.subscribeToTopic(payload.id, payload.email);
  }

  private async subscribeToTopic(id :string, emailAccount: string): Promise<void> {
    const gmailClient =
      await this.gmailClientFactory.createClient(emailAccount);

      try {

        const response = await gmailClient.users.watch({
            userId: 'me',
            requestBody: {
            topicName: this.topicName,
            labelIds: ['INBOX', 'SENT'],
            labelFilterBehavior: 'include',
            },
        });

        const expirationEpoch = Number(response.data.expiration);

        await this.prisma.webhookSubscription.upsert({
            where:{connectedAccountId: id},
            update: {
                expirationDate: new Date(expirationEpoch),
            },
            create: {
                connectedAccountId: id,
                expirationDate: new Date(expirationEpoch),
            },
        })

        this.logger.log(`Subscribed to Gmail Pub/Sub topic for account ${emailAccount}. Subscription expires at ${new Date(expirationEpoch).toISOString()}`);

      } catch (error) {
        this.logger.error(`Failed to subscribe to Gmail Pub/Sub topic for account ${emailAccount}: ${error.message}`);
      }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  private renewSubscriptions(): void {
    this.logger.log('Starting daily Gmail Pub/Sub subscription renewal...');
  }
}
