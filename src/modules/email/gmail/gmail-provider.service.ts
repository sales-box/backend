import { Injectable } from '@nestjs/common';
import { EmailProvider } from '@/modules/email/email-provider.abstract';
import { EmailThread, ParsedMessage } from '@/modules/email/email.types';
import { GmailParserService } from '@/modules/email/gmail/gmail-parser.service';
import { GmailClientFactory } from '@/modules/email/gmail/gmail-client.factory';
import { gmail_v1 } from 'googleapis';

@Injectable()
export class GmailProvider implements EmailProvider {
  constructor(
    private readonly clientFactory: GmailClientFactory,
    private readonly parser: GmailParserService,
  ) {}

  async fetchMessage(
    messageId: string,
    emailAccount: string,
  ): Promise<ParsedMessage> {
    const gmailClient = await this.clientFactory.createClient(emailAccount);

    const message = await gmailClient.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    return this.parser.parseMessage(message.data);
  }

  async fetchThreads(
    emailAccount: string,
    query?: string,
  ): Promise<EmailThread[]> {
    const gmailClient = await this.clientFactory.createClient(emailAccount);
    const allThreads: gmail_v1.Schema$Thread[] = [];
    let pageToken: string | undefined = undefined;

    do {
      try {
        const listRes: { data: gmail_v1.Schema$ListThreadsResponse } =
          await gmailClient.users.threads.list({
            userId: 'me',
            q: query,
            pageToken: pageToken,
            maxResults: 20,
          });
        const threads = listRes.data.threads ?? [];
        allThreads.push(...threads);
        pageToken = listRes.data.nextPageToken ?? undefined;
      } catch {
        break;
      }
    } while (pageToken);

    if (allThreads.length === 0) {
      return [];
    }

    const threadDetailsPromises = allThreads.map(async (t) => {
      try {
        const threadRes: { data: gmail_v1.Schema$Thread } =
          await gmailClient.users.threads.get({
            userId: 'me',
            id: t.id!,
          });
        return threadRes.data;
      } catch {
        return null;
      }
    });

    const rawThreads = await Promise.all(threadDetailsPromises);
    const validThreads = rawThreads.filter(
      (t) => t !== null && t !== undefined,
    );

    const parsedThreads = validThreads.map((thread) =>
      this.parser.parseThread(thread),
    );

    // Sort threads descending by the date of the most recent message inside the thread
    parsedThreads.sort((a, b) => {
      const getLatestDate = (thread: EmailThread) => {
        if (!thread.messages.length) return 0;
        const timestamps = thread.messages.map((m) =>
          new Date(m.date).getTime(),
        );
        return Math.max(...timestamps);
      };
      return getLatestDate(b) - getLatestDate(a);
    });

    return parsedThreads;
  }
}
