import { Injectable } from '@nestjs/common';
import { EmailProvider } from '@/modules/email/email-provider.abstract';
import { EmailThread, ParsedMessage } from '@/modules/email/email.types';
import { GmailParserService } from '@/modules/email/gmail/gmail-parser.service';
import { GmailClientFactory } from '@/modules/email/gmail/gmail-client.factory';
import {
  NewMessagesResult,
  NewSentThreadsResult,
} from '@/modules/email/gmail/gmail.types';
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

  /**
   * Diffs Gmail history since the stored baseline and returns the ids of
   * messages newly added to INBOX (SENT and drafts excluded via labelId).
   * 404 from Gmail (= baseline older than the ~1 week history window) is
   * deliberately NOT handled here — the classifier processor resets its
   * baseline on that signal.
   */
  async fetchNewMessageIds(
    emailAccount: string,
    startHistoryId: string,
  ): Promise<NewMessagesResult> {
    const gmailClient = await this.clientFactory.createClient(emailAccount);
    const messageIds = new Set<string>();
    let newHistoryId = startHistoryId;
    let pageToken: string | undefined = undefined;

    do {
      const res: { data: gmail_v1.Schema$ListHistoryResponse } =
        await gmailClient.users.history.list({
          userId: 'me',
          startHistoryId,
          historyTypes: ['messageAdded'],
          labelId: 'INBOX',
          pageToken,
        });

      for (const entry of res.data.history ?? []) {
        for (const added of entry.messagesAdded ?? []) {
          if (added.message?.id) messageIds.add(added.message.id);
        }
      }
      if (res.data.historyId) newHistoryId = res.data.historyId;
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return { messageIds: [...messageIds], newHistoryId };
  }

  async fetchNewSentThreadIds(
    emailAccount: string,
    startHistoryId: string,
  ): Promise<NewSentThreadsResult> {
    const gmailClient = await this.clientFactory.createClient(emailAccount);
    const threadIds = new Set<string>();
    let newHistoryId = startHistoryId;
    let pageToken: string | undefined = undefined;

    do {
      const res: { data: gmail_v1.Schema$ListHistoryResponse } =
        await gmailClient.users.history.list({
          userId: 'me',
          startHistoryId,
          historyTypes: ['messageAdded'],
          labelId: 'SENT',
          pageToken,
        });

      for (const entry of res.data.history ?? []) {
        for (const added of entry.messagesAdded ?? []) {
          if (added.message?.threadId) threadIds.add(added.message.threadId);
        }
      }
      if (res.data.historyId) newHistoryId = res.data.historyId;
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return { threadIds: [...threadIds], newHistoryId };
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
