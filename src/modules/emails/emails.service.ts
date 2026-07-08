import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { EmailService } from '@/modules/email/email.service';

@Injectable()
export class EmailsService {
  private readonly logger = new Logger(EmailsService.name);

  constructor(private readonly emailService: EmailService) {}

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
    try {
      const oauth2Client = new google.auth.OAuth2();
      oauth2Client.setCredentials({ access_token: accessToken });
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const emailAccount = profile.data.emailAddress;
      if (!emailAccount) {
        throw new Error('Could not resolve email account from token');
      }

      const emailThreads = await this.emailService.fetchThreads(
        emailAccount,
        clientEmail,
      );

      const formattedThreads = emailThreads.map((thread) => {
        const messages = thread.messages || [];
        if (messages.length === 0) {
          return {
            date: new Date().toISOString(),
            subject: '(No Subject)',
            snippet: thread.snippet || '',
            direction: 'inbound' as const,
          };
        }

        // Sort messages chronologically by date (oldest to newest)
        const sortedMessages = [...messages].sort((a, b) => {
          return new Date(a.date).getTime() - new Date(b.date).getTime();
        });

        const latestMessage = sortedMessages[sortedMessages.length - 1];
        const firstMessage = sortedMessages[0];

        const subject = firstMessage.subject || '(No Subject)';
        const date = latestMessage.date;
        const snippet =
          latestMessage.textPlain ||
          latestMessage.textHtml ||
          thread.snippet ||
          '';

        const fromEmail = this.extractEmailAddress(latestMessage.from);
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
      return [];
    }
  }

  private extractEmailAddress(fromValue: string): string {
    const match = fromValue.match(/<([^>]+)>/);
    return match ? match[1].trim() : fromValue.trim();
  }
}
