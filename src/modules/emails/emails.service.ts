import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { EmailService } from '@/modules/email/email.service';
import { GmailClientProvider } from './gmail-client.provider';
import { PrismaService } from '@/database/prisma.service';

@Injectable()
export class EmailsService {
  private readonly logger = new Logger(EmailsService.name);

  constructor(
    private readonly emailService: EmailService,
    private readonly gmailClientProvider: GmailClientProvider,
    private readonly prisma: PrismaService,
  ) {}

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

  async getInboxStatsForSe(
    email: string,
    tenantId?: string,
  ): Promise<{
    totalEmails: number;
    syncedAt: string;
    urgentCount: number;
    intentBreakdown: Record<string, number>;
    reviewedBreakdown: { green: number; yellow: number; red: number };
    notYetReviewedCount: number;
  }> {
    const gmail = await this.gmailClientProvider.getClientForAccount(
      email,
      tenantId,
    );
    const { data } = await gmail.users.threads.list({ userId: 'me' });
    const activeThreads = data.threads || [];
    const activeThreadIds = activeThreads
      .map((t) => t.id)
      .filter((id): id is string => !!id);

    interface AnalysisRow {
      threadId: string | null;
      isUrgent: boolean;
      intent: string;
      supervisorLabel: string | null;
      reviewedAt: Date | null;
    }

    let analyses: AnalysisRow[] = [];

    if (tenantId) {
      const rawAnalyses = await this.prisma.$queryRaw<unknown[]>`
        SELECT DISTINCT ON (thread_id)
          thread_id as "threadId",
          is_urgent as "isUrgent",
          intent,
          supervisor_label as "supervisorLabel",
          reviewed_at as "reviewedAt"
        FROM general_analysis
        WHERE tenant_id = ${tenantId}::uuid AND account_email = ${email}
        ORDER BY thread_id, created_at DESC
      `;
      analyses = rawAnalyses as AnalysisRow[];
    } else {
      const rawAnalyses = await this.prisma.$queryRaw<unknown[]>`
        SELECT DISTINCT ON (thread_id)
          thread_id as "threadId",
          is_urgent as "isUrgent",
          intent,
          supervisor_label as "supervisorLabel",
          reviewed_at as "reviewedAt"
        FROM general_analysis
        WHERE tenant_id IS NULL AND account_email = ${email}
        ORDER BY thread_id, created_at DESC
      `;
      analyses = rawAnalyses as AnalysisRow[];
    }

    const activeThreadIdsSet = new Set(activeThreadIds);
    const filteredAnalyses = analyses.filter(
      (a) => a.threadId && activeThreadIdsSet.has(a.threadId),
    );

    let urgentCount = 0;
    const intentBreakdown: Record<string, number> = {};
    const reviewedBreakdown = { green: 0, yellow: 0, red: 0 };

    for (const a of filteredAnalyses) {
      if (a.isUrgent) {
        urgentCount++;
      }
      if (a.intent) {
        intentBreakdown[a.intent] = (intentBreakdown[a.intent] || 0) + 1;
      }
      if (a.reviewedAt !== null && a.reviewedAt !== undefined) {
        const label = a.supervisorLabel;
        if (label === 'green' || label === 'yellow' || label === 'red') {
          reviewedBreakdown[label]++;
        }
      }
    }

    let notYetReviewedCount = 0;
    for (const threadId of activeThreadIds) {
      const a = filteredAnalyses.find((x) => x.threadId === threadId);
      if (!a || a.reviewedAt === null || a.reviewedAt === undefined) {
        notYetReviewedCount++;
      }
    }

    return {
      totalEmails: activeThreads.length,
      syncedAt: new Date().toISOString(),
      urgentCount,
      intentBreakdown,
      reviewedBreakdown,
      notYetReviewedCount,
    };
  }

  private extractEmailAddress(fromValue: string): string {
    const match = fromValue.match(/<([^>]+)>/);
    return match ? match[1].trim() : fromValue.trim();
  }
}
