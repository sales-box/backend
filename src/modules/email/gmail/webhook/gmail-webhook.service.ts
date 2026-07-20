import { Injectable, Logger } from '@nestjs/common';
import { GmailClientFactory } from '@/modules/email/gmail/gmail-client.factory';
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
  private async handleGoogleAccountConnected(payload: {
    id: string;
    email: string;
  }): Promise<void> {
    this.logger.log(
      `Detected new Google account connection for ${payload.email}. Initializing Pub/Sub...`,
    );
    await this.subscribeToTopic(payload.id, payload.email);
  }

  private async subscribeToTopic(
    id: string,
    emailAccount: string,
  ): Promise<void> {
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
      const watchHistoryId = response.data.historyId
        ? String(response.data.historyId)
        : null;

      await this.prisma.webhookSubscription.upsert({
        where: { connectedAccountId: id },
        update: {
          expirationDate: new Date(expirationEpoch),
        },
        create: {
          connectedAccountId: id,
          expirationDate: new Date(expirationEpoch),
          // Baseline for the classifier's history diff: everything AFTER this
          // watch call counts as "new". Renewals must NOT overwrite an existing
          // baseline — that would silently skip unprocessed messages.
          lastHistoryId: watchHistoryId,
        },
      });

      this.logger.log(
        `Subscribed to Gmail Pub/Sub topic for account ${emailAccount}. Subscription expires at ${new Date(expirationEpoch).toISOString()}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to subscribe to Gmail Pub/Sub topic for account ${emailAccount}: ${errorMessage}`,
      );
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  private async renewSubscriptions(): Promise<void> {
    this.logger.log('Starting daily Gmail Pub/Sub subscription renewal...');

    // Renew anything expiring within the next 48h — daily cadence with a
    // 48h window gives headroom if a run is missed or a renewal fails.
    const expiringBefore = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const expiringSoon = await this.prisma.webhookSubscription.findMany({
      where: { expirationDate: { lte: expiringBefore } },
      include: { connectedAccount: true }, // adjust relation name to match schema.prisma
    });

    this.logger.log(
      `Found ${expiringSoon.length} Gmail Pub/Sub subscription(s) expiring within 48h.`,
    );

    for (const sub of expiringSoon) {
      if (!sub.connectedAccount?.email) {
        this.logger.warn(
          `Skipping renewal for subscription ${sub.connectedAccountId}: no linked connected account email found.`,
        );
        continue;
      }
      try {
        await this.subscribeToTopic(
          sub.connectedAccountId,
          sub.connectedAccount.email,
        );
      } catch {
        // subscribeToTopic already logs its own failure; this just keeps
        // one bad account from stopping the rest of the batch.
        this.logger.error(
          `Renewal failed for ${sub.connectedAccount.email}, continuing with remaining accounts.`,
        );
      }
    }
  }
}
