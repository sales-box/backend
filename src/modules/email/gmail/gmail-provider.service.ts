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
    tenantId: string,
    messageId: string,
    emailAccount: string,
  ): Promise<ParsedMessage> {
    const gmailClient = await this.clientFactory.createClient(
      tenantId,
      emailAccount,
    );

    const message = await gmailClient.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    return this.parser.parseMessage(message.data);
  }

  /**
   * Resolves internal Gmail labelIds matching the 'salesbox' label
   * (handles name variations such as 'Salesbox', 'SalesBox', 'Sales Box', 'sales-box', 'salesbox/inbound').
   */
  async getSalesboxLabelIds(
    tenantId: string,
    emailAccount: string,
  ): Promise<string[]> {
    try {
      const gmailClient = await this.clientFactory.createClient(
        tenantId,
        emailAccount,
      );
      const res = await gmailClient.users.labels.list({ userId: 'me' });
      const labels = res.data.labels ?? [];
      const matches = labels.filter((l) => {
        if (!l.name) return false;
        const normalized = l.name.toLowerCase().replace(/[\s-_]/g, '');
        return normalized === 'salesbox' || normalized.startsWith('salesbox/');
      });
      return matches.map((m) => m.id!).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Resolves the primary internal Gmail labelId for a given label name.
   */
  async getLabelIdByName(
    tenantId: string,
    emailAccount: string,
    _labelName = 'salesbox',
  ): Promise<string | null> {
    const ids = await this.getSalesboxLabelIds(tenantId, emailAccount);
    return ids[0] ?? null;
  }

  /**
   * Diffs Gmail history since the stored baseline and returns the ids of
   * messages newly added/labeled with the 'salesbox' label.
   * 404 from Gmail (= baseline older than the ~1 week history window) is
   * deliberately NOT handled here — the classifier processor resets its
   * baseline on that signal.
   */
  /**
   * Message ids already sitting under the salesbox label, newest first.
   *
   * `fetchNewMessageIds` walks the history feed, which only ever moves FORWARD
   * from the watch baseline — so mail that arrived before a company connected
   * its mailbox is invisible to it, permanently. That is the backlog this
   * exists to reach.
   *
   * Ids only. The caller fetches each message itself, so a large mailbox does
   * not pull thousands of bodies into memory to decide it is over the cap.
   * Both bounds are enforced: `newerThanDays` server-side via Gmail's query
   * language, `maxMessages` by stopping the page walk.
   */
  async listLabelledMessageIds(
    tenantId: string,
    emailAccount: string,
    opts: { maxMessages: number; newerThanDays: number },
  ): Promise<string[]> {
    const gmailClient = await this.clientFactory.createClient(
      tenantId,
      emailAccount,
    );

    const salesboxLabelIds = await this.getSalesboxLabelIds(
      tenantId,
      emailAccount,
    );
    // Same guard as fetchNewMessageIds: with no label id, Gmail would happily
    // list the ENTIRE mailbox rather than the salesbox subset.
    if (salesboxLabelIds.length === 0) {
      return [];
    }

    const ids: string[] = [];
    const seen = new Set<string>();

    // Several label ids can match ("salesbox", "salesbox/inbound"), and a
    // message can carry more than one, hence the dedupe.
    for (const labelId of salesboxLabelIds) {
      let pageToken: string | undefined = undefined;
      do {
        const res: { data: gmail_v1.Schema$ListMessagesResponse } =
          await gmailClient.users.messages.list({
            userId: 'me',
            labelIds: [labelId],
            q: `newer_than:${opts.newerThanDays}d`,
            maxResults: Math.min(500, opts.maxMessages - ids.length),
            pageToken,
          });

        for (const m of res.data.messages ?? []) {
          if (!m.id || seen.has(m.id)) continue;
          seen.add(m.id);
          ids.push(m.id);
          if (ids.length >= opts.maxMessages) return ids;
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
    }

    return ids;
  }

  async fetchNewMessageIds(
    tenantId: string,
    emailAccount: string,
    startHistoryId: string,
  ): Promise<NewMessagesResult> {
    const gmailClient = await this.clientFactory.createClient(
      tenantId,
      emailAccount,
    );

    const salesboxLabelIds = await this.getSalesboxLabelIds(
      tenantId,
      emailAccount,
    );

    // CRITICAL: If no salesbox label exists on this account, return empty messageIds.
    // Calling history.list with labelId = undefined would return ALL inbox messages.
    if (salesboxLabelIds.length === 0) {
      return { messageIds: [], newHistoryId: startHistoryId };
    }

    const messageIds = new Set<string>();
    let newHistoryId = startHistoryId;

    for (const labelId of salesboxLabelIds) {
      let pageToken: string | undefined = undefined;
      do {
        const res: { data: gmail_v1.Schema$ListHistoryResponse } =
          await gmailClient.users.history.list({
            userId: 'me',
            startHistoryId,
            historyTypes: ['messageAdded', 'labelAdded'],
            labelId,
            pageToken,
          });

        for (const entry of res.data.history ?? []) {
          for (const added of entry.messagesAdded ?? []) {
            if (added.message?.id) messageIds.add(added.message.id);
          }
          for (const labeled of entry.labelsAdded ?? []) {
            if (labeled.message?.id) messageIds.add(labeled.message.id);
          }
        }
        if (res.data.historyId) newHistoryId = res.data.historyId;
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
    }

    return { messageIds: [...messageIds], newHistoryId };
  }

  async fetchNewSentThreadIds(
    tenantId: string,
    emailAccount: string,
    startHistoryId: string,
  ): Promise<NewSentThreadsResult> {
    const gmailClient = await this.clientFactory.createClient(
      tenantId,
      emailAccount,
    );
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
    tenantId: string,
    emailAccount: string,
    query?: string,
  ): Promise<EmailThread[]> {
    const gmailClient = await this.clientFactory.createClient(
      tenantId,
      emailAccount,
    );
    const salesboxLabelIds = await this.getSalesboxLabelIds(
      tenantId,
      emailAccount,
    );
    if (salesboxLabelIds.length === 0) {
      return [];
    }

    const allThreads: gmail_v1.Schema$Thread[] = [];
    let pageToken: string | undefined = undefined;

    do {
      try {
        const listRes: { data: gmail_v1.Schema$ListThreadsResponse } =
          await gmailClient.users.threads.list({
            userId: 'me',
            labelIds: salesboxLabelIds,
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
