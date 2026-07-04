import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { GmailClientProvider } from './gmail-client.provider';

const POLL_INTERVAL_MS = 60_000;
const UNREAD_LAST_24H_QUERY = 'is:unread newer_than:1d';

@Injectable()
export class GmailPollingService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(GmailPollingService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gmailClientProvider: GmailClientProvider,
  ) {}

  onApplicationBootstrap(): void {
    // this.timer = setInterval(() => {
    //   void this.pollAllAccounts();
    // }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async pollAllAccounts(): Promise<void> {
    try {
      const accounts = await this.prisma.connectedAccount.findMany({
        where: { status: 'connected' },
        select: { email: true },
      });

      for (const account of accounts) {
        try {
          await this.pollAccount(account.email);
        } catch (error) {
          this.logger.error(
            `Polling failed for ${account.email}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Gmail polling failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async pollAccount(email: string): Promise<void> {
    const gmail = await this.gmailClientProvider.getClientForAccount(email);

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: UNREAD_LAST_24H_QUERY,
      maxResults: 25,
    });

    const messages = response.data.messages ?? [];

    for (const message of messages) {
      if (!message.id) continue;

      const alreadyProcessed =
        await this.prisma.processedGmailMessage.findUnique({
          where: { messageId: message.id },
        });

      if (alreadyProcessed) {
        this.logger.debug(`Skipping duplicate Gmail message ${message.id}`);
        continue;
      }

      await this.prisma.processedGmailMessage.create({
        data: {
          messageId: message.id,
          threadId: message.threadId ?? null,
          accountEmail: email,
        },
      });

      this.logger.log(`Queued new Gmail message ${message.id} from ${email}`);
    }
  }
}
