import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { gmail_v1, google } from 'googleapis';
import { EmailService } from '@/modules/email/email.service';
import { GmailClientProvider } from './gmail-client.provider';
import { PrismaService } from '@/database/prisma.service';
import { ClientsService } from '@/modules/clients/clients.service';
import { EmailRowData } from './emails.types';
import {
  REVIEW_STATUS_BY_LABEL,
  ReviewedLabel,
  isKnownCategory,
  matchesCategory,
} from './email-categorizer.util';

interface AnalysisRow {
  threadId: string | null;
  isUrgent: boolean;
  intent: string;
  supervisorLabel: string | null;
  reviewedAt: Date | null;
}

// Keeps the categorized-list endpoint responsive on large inboxes and
// avoids hammering the Gmail API with one threads.get per match.
const MAX_CATEGORIZED_RESULTS = 50;

@Injectable()
export class EmailsService {
  private readonly logger = new Logger(EmailsService.name);

  constructor(
    private readonly emailService: EmailService,
    private readonly gmailClientProvider: GmailClientProvider,
    private readonly prisma: PrismaService,
    private readonly clientsService: ClientsService,
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

    const analyses = await this.fetchLatestAnalyses(email, tenantId);
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

  /**
   * Powers the InboxOverviewScreen drill-down (urgent / by-intent /
   * review-status / not-reviewed buttons -> GET /emails/categorized).
   */
  async getCategorizedEmailsForSe(
    email: string,
    category: string,
    tenantId?: string,
  ): Promise<EmailRowData[]> {
    if (!isKnownCategory(category)) {
      throw new BadRequestException(`Unknown category: ${category}`);
    }

    const gmail = await this.gmailClientProvider.getClientForAccount(
      email,
      tenantId,
    );
    const { data } = await gmail.users.threads.list({ userId: 'me' });
    const activeThreadIds = (data.threads || [])
      .map((t) => t.id)
      .filter((id): id is string => !!id);

    const analyses = await this.fetchLatestAnalyses(email, tenantId);
    const analysisByThreadId = new Map(
      analyses
        .filter((a): a is AnalysisRow & { threadId: string } => !!a.threadId)
        .map((a) => [a.threadId, a]),
    );

    const matchingThreadIds = activeThreadIds.filter((threadId) => {
      const analysis = analysisByThreadId.get(threadId);
      if (!analysis) {
        // No analysis row yet -> only the "not-reviewed" bucket claims it.
        return category === 'not-reviewed';
      }
      return matchesCategory(analysis, category);
    });

    const limitedThreadIds = matchingThreadIds.slice(
      0,
      MAX_CATEGORIZED_RESULTS,
    );

    const rows = await Promise.all(
      limitedThreadIds.map((threadId) =>
        this.buildEmailRow(
          gmail,
          threadId,
          tenantId,
          analysisByThreadId.get(threadId),
        ),
      ),
    );

    return rows
      .filter((row): row is EmailRowData => row !== null)
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
  }

  /** Single source of truth for the DISTINCT-ON-latest-analysis-per-thread query. */
  private async fetchLatestAnalyses(
    email: string,
    tenantId?: string,
  ): Promise<AnalysisRow[]> {
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
      return rawAnalyses as AnalysisRow[];
    }

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
    return rawAnalyses as AnalysisRow[];
  }

  /** Fetches subject/sender/date from Gmail and best-effort client identity. */
  private async buildEmailRow(
    gmail: gmail_v1.Gmail,
    threadId: string,
    tenantId: string | undefined,
    analysis: AnalysisRow | undefined,
  ): Promise<EmailRowData | null> {
    try {
      const { data: thread } = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });

      const messages = thread.messages || [];
      const latestMessage = messages[messages.length - 1];
      const headers = latestMessage?.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
          ?.value || '';

      const subject = getHeader('Subject') || '(No Subject)';
      const dateHeader = getHeader('Date');
      const timestamp = dateHeader
        ? new Date(dateHeader).toISOString()
        : new Date().toISOString();
      const senderEmail = this.extractEmailAddress(getHeader('From'));

      let clientName = '';
      let company = '';
      if (tenantId && senderEmail) {
        try {
          const context = await this.clientsService.getClientContext(
            tenantId,
            senderEmail,
          );
          clientName = context.name;
          company = context.company;
        } catch {
          // Best-effort enrichment — an unresolved client shouldn't hide the email.
        }
      }

      const status =
        analysis?.reviewedAt && analysis.supervisorLabel
          ? REVIEW_STATUS_BY_LABEL[analysis.supervisorLabel as ReviewedLabel]
          : undefined;

      return {
        threadId,
        clientName: clientName || 'Unknown',
        company,
        subjectSnippet: thread.snippet || subject,
        timestamp,
        status,
      };
    } catch (error) {
      this.logger.error(
        `Failed to build email row for thread ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private extractEmailAddress(fromValue: string): string {
    const match = fromValue.match(/<([^>]+)>/);
    return match ? match[1].trim() : fromValue.trim();
  }
}
