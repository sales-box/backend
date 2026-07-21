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

  /**
   * Emails in ONE drill-down category for the SE's active inbox — powers the
   * extension's category lists (Urgent, per-intent, and review-status tiles).
   *
   * The extension sends display-format category keys ('product-inquiry',
   * 'demo-request', 'ready'/'needs-review'/'manual', 'urgent', 'not-reviewed');
   * the DB stores space-separated intents and green/yellow/red labels. The
   * mapping lives here so the extension never has to know the storage shape.
   */
  async getCategorizedEmailsForSe(
    email: string,
    tenantId: string | undefined,
    category: string,
  ): Promise<
    Array<{
      threadId: string;
      clientName: string;
      company: string;
      subjectSnippet: string;
      timestamp: string;
      status?: 'ready' | 'needs-review' | 'manual';
    }>
  > {
    const filter = this.categoryToFilter(category);
    if (!filter) return [];

    const gmail = await this.gmailClientProvider.getClientForAccount(
      email,
      tenantId,
    );
    const { data } = await gmail.users.threads.list({ userId: 'me' });
    const activeThreadIds = new Set(
      (data.threads || []).map((t) => t.id).filter((id): id is string => !!id),
    );
    if (activeThreadIds.size === 0) return [];

    interface AnalysisRow {
      threadId: string | null;
      isUrgent: boolean;
      intent: string;
      supervisorLabel: string | null;
      reviewedAt: Date | null;
    }
    const rows = tenantId
      ? await this.prisma.$queryRaw<AnalysisRow[]>`
          SELECT DISTINCT ON (thread_id)
            thread_id as "threadId", is_urgent as "isUrgent", intent,
            supervisor_label as "supervisorLabel", reviewed_at as "reviewedAt"
          FROM general_analysis
          WHERE tenant_id = ${tenantId}::uuid AND account_email = ${email}
          ORDER BY thread_id, created_at DESC`
      : await this.prisma.$queryRaw<AnalysisRow[]>`
          SELECT DISTINCT ON (thread_id)
            thread_id as "threadId", is_urgent as "isUrgent", intent,
            supervisor_label as "supervisorLabel", reviewed_at as "reviewedAt"
          FROM general_analysis
          WHERE tenant_id IS NULL AND account_email = ${email}
          ORDER BY thread_id, created_at DESC`;

    const matched = rows.filter(
      (r) =>
        r.threadId &&
        activeThreadIds.has(r.threadId) &&
        this.matchesCategory(r, filter),
    );
    if (matched.length === 0) return [];

    const built = await Promise.all(
      matched.map((r) => this.buildCategoryRow(gmail, r, email, tenantId)),
    );
    return built.filter((x): x is NonNullable<typeof x> => x !== null);
  }

  private categoryToFilter(
    category: string,
  ):
    | { kind: 'intent'; intent: string }
    | { kind: 'urgent' }
    | { kind: 'label'; label: 'green' | 'yellow' | 'red' }
    | { kind: 'not-reviewed' }
    | null {
    const intents: Record<string, string> = {
      'product-inquiry': 'product inquiry',
      'demo-request': 'demo request',
      support: 'support',
      'follow-up': 'follow-up',
      sensitive: 'sensitive',
    };
    if (intents[category]) return { kind: 'intent', intent: intents[category] };
    if (category === 'urgent') return { kind: 'urgent' };
    if (category === 'ready') return { kind: 'label', label: 'green' };
    if (category === 'needs-review') return { kind: 'label', label: 'yellow' };
    if (category === 'manual') return { kind: 'label', label: 'red' };
    if (category === 'not-reviewed') return { kind: 'not-reviewed' };
    return null;
  }

  private matchesCategory(
    r: {
      isUrgent: boolean;
      intent: string;
      supervisorLabel: string | null;
      reviewedAt: Date | null;
    },
    filter: ReturnType<EmailsService['categoryToFilter']>,
  ): boolean {
    if (!filter) return false;
    switch (filter.kind) {
      case 'intent':
        return r.intent === filter.intent;
      case 'urgent':
        return r.isUrgent === true;
      case 'label':
        return r.reviewedAt != null && r.supervisorLabel === filter.label;
      case 'not-reviewed':
        return r.reviewedAt == null;
    }
  }

  private labelToStatus(
    reviewedAt: Date | null,
    label: string | null,
  ): 'ready' | 'needs-review' | 'manual' | undefined {
    if (!reviewedAt) return undefined;
    if (label === 'green') return 'ready';
    if (label === 'yellow') return 'needs-review';
    if (label === 'red') return 'manual';
    return undefined;
  }

  private extractDisplayName(fromValue: string): string {
    const m = fromValue.match(/^\s*"?([^"<]+?)"?\s*</);
    return m ? m[1].trim() : '';
  }

  private async buildCategoryRow(
    gmail: Awaited<ReturnType<GmailClientProvider['getClientForAccount']>>,
    r: {
      threadId: string | null;
      supervisorLabel: string | null;
      reviewedAt: Date | null;
    },
    seEmail: string,
    tenantId: string | undefined,
  ): Promise<{
    threadId: string;
    clientName: string;
    company: string;
    subjectSnippet: string;
    timestamp: string;
    status?: 'ready' | 'needs-review' | 'manual';
  } | null> {
    if (!r.threadId) return null;
    try {
      const { data } = await gmail.users.threads.get({
        userId: 'me',
        id: r.threadId,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });
      const messages = data.messages || [];
      if (messages.length === 0) return null;

      const headerOf = (msg: (typeof messages)[number], name: string): string =>
        (msg.payload?.headers || []).find(
          (h) => h.name?.toLowerCase() === name.toLowerCase(),
        )?.value || '';

      const latest = messages[messages.length - 1];
      const subject =
        headerOf(latest, 'Subject') || data.snippet || '(No subject)';

      // Prefer the client's address: the first message NOT from the SE inbox.
      let fromValue = headerOf(latest, 'From');
      for (const m of messages) {
        const f = headerOf(m, 'From');
        if (
          f &&
          this.extractEmailAddress(f).toLowerCase() !== seEmail.toLowerCase()
        ) {
          fromValue = f;
          break;
        }
      }
      const senderEmail = this.extractEmailAddress(fromValue);
      const timestamp = latest.internalDate
        ? new Date(Number(latest.internalDate)).toISOString()
        : new Date().toISOString();

      let clientName = this.extractDisplayName(fromValue) || senderEmail;
      let company = '';
      const client = await this.prisma.client.findFirst({
        where: tenantId
          ? { tenantId, email: senderEmail }
          : { email: senderEmail },
        select: { name: true, company: true },
      });
      if (client) {
        clientName = client.name || clientName;
        company = client.company || '';
      }

      return {
        threadId: r.threadId,
        clientName,
        company,
        subjectSnippet: subject,
        timestamp,
        status: this.labelToStatus(r.reviewedAt, r.supervisorLabel),
      };
    } catch (error) {
      this.logger.warn(
        `Failed to build category row for thread ${r.threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private extractEmailAddress(fromValue: string): string {
    const match = fromValue.match(/<([^>]+)>/);
    return match ? match[1].trim() : fromValue.trim();
  }
}
