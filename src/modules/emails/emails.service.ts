import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';

@Injectable()
export class EmailsService {
  private readonly logger = new Logger(EmailsService.name);

  async fetchThreadsForClient(
    clientEmail: string,
    accessToken: string,
  ): Promise<
    {
      date: string;
      subject: string;
      snippet: string;
      direction: 'inbound' | 'outbound';
    }[]
  > {
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    try {
      // Query threads involving clientEmail (covers to, from, cc, bcc)
      const listRes = await gmail.users.threads.list({
        userId: 'me',
        q: clientEmail,
      });

      const threads = listRes.data.threads || [];
      if (threads.length === 0) {
        return [];
      }

      // Fetch detailed thread objects
      const threadDetailsPromises = threads.map(async (t) => {
        const threadRes = await gmail.users.threads.get({
          userId: 'me',
          id: t.id!,
        });
        return threadRes.data;
      });

      const fullThreads = await Promise.all(threadDetailsPromises);

      const formattedThreads = fullThreads.map((thread) => {
        const messages = thread.messages || [];
        if (messages.length === 0) {
          return {
            date: new Date().toISOString(),
            subject: '(No Subject)',
            snippet: thread.snippet || '',
            direction: 'inbound' as const,
          };
        }

        // Sort messages chronologically by internalDate (oldest to newest)
        // so that the last message is the most recent one.
        const sortedMessages = [...messages].sort((a, b) => {
          const tA = parseInt(a.internalDate || '0', 10);
          const tB = parseInt(b.internalDate || '0', 10);
          return tA - tB;
        });

        const latestMessage = sortedMessages[sortedMessages.length - 1];
        const firstMessage = sortedMessages[0];

        // Extract Subject from first message's headers
        const firstHeaders = firstMessage.payload?.headers || [];
        const subjectHeader = firstHeaders.find(
          (h) => h.name?.toLowerCase() === 'subject',
        );
        const subject = subjectHeader?.value || '(No Subject)';

        // Extract Date from latest message's internalDate
        const latestTimestamp = parseInt(latestMessage.internalDate || '0', 10);
        const date = latestTimestamp
          ? new Date(latestTimestamp).toISOString()
          : new Date().toISOString();

        // Extract Snippet
        const snippet = latestMessage.snippet || thread.snippet || '';

        // Extract Direction: inbound if sender of latest message matches clientEmail
        const latestHeaders = latestMessage.payload?.headers || [];
        const fromHeader = latestHeaders.find(
          (h) => h.name?.toLowerCase() === 'from',
        );
        const fromValue = fromHeader?.value || '';
        const fromEmail = this.extractEmailAddress(fromValue);

        const direction =
          fromEmail.toLowerCase() === clientEmail.toLowerCase()
            ? ('inbound' as const)
            : ('outbound' as const);

        return {
          date,
          subject,
          snippet,
          direction,
        };
      });

      // Sort threads descending by date (newest/most recent first)
      formattedThreads.sort((a, b) => {
        return new Date(b.date).getTime() - new Date(a.date).getTime();
      });

      return formattedThreads;
    } catch (error) {
      this.logger.error(
        `Failed to fetch threads for client ${clientEmail}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private extractEmailAddress(fromValue: string): string {
    const match = fromValue.match(/<([^>]+)>/);
    return match ? match[1].trim() : fromValue.trim();
  }
}
