import { Injectable, Logger } from '@nestjs/common';
import { assertOwnsGraphThread } from '@/modules/ai/graphs/reply/graph-thread-id';
import { Prisma, GeneralAnalysis } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { GmailProvider } from '@/modules/email/gmail/gmail-provider.service';
import { ClassifierService } from '@/modules/ai/classifier/classifier.service';
import { CLASSIFIER_PROMPT_VERSION } from '@/modules/ai/classifier/classifier.constants';
import { ClientsService } from '@/modules/clients/clients.service';
import { ReplyService } from '@/modules/ai/graphs/reply/reply.service';
import { SupervisorService } from '@/modules/ai/supervisor/supervisor.service';
import { SupervisorInput } from '@/modules/ai/supervisor/supervisor.types';
import { CRMActionsAgent } from './graphs/actions/crm-actions.agent';

import { FaqService } from '@/modules/faq/faq.service';

/** high > medium > low. Used to make an escalation's severity monotonic. */
const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/**
 * The higher of the two, or the new one when there is nothing to compare to.
 * Two independent writers touch the same escalation — the background
 * classifier and the on-demand pipeline — and they see different evidence.
 * Whichever runs second must not be able to talk the first one down.
 */
function raiseSeverity(existing: string | undefined, next: string): string {
  if (!existing) return next;
  return (SEVERITY_RANK[existing] ?? 0) >= (SEVERITY_RANK[next] ?? 0)
    ? existing
    : next;
}

@Injectable()
export class AiOrchestratorService {
  private readonly logger = new Logger(AiOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gmailProvider: GmailProvider,
    private readonly classifierService: ClassifierService,
    private readonly clientsService: ClientsService,
    private readonly replyService: ReplyService,
    private readonly supervisorService: SupervisorService,
    private readonly crmActionsAgent: CRMActionsAgent,
    private readonly faqService?: FaqService,
  ) {}

  /**
   * Returns a cached GeneralAnalysis row if the background webhook processor
   * already handled this message; otherwise runs classify() directly (same
   * method the processor calls) and persists the result so the processor won't
   * double-call the LLM when it eventually arrives (P2002 → re-read pattern).
   */
  private async getOrRunClassification(
    messageId: string,
    accountEmail: string,
    tenantId: string,
    text: string,
    threadId: string | null,
    subject = '',
    clientEmail = '',
  ) {
    const existing = await this.prisma.generalAnalysis.findUnique({
      where: { messageId },
    });
    if (existing) {
      if (!existing.tenantId && tenantId) {
        return this.prisma.generalAnalysis.update({
          where: { id: existing.id },
          data: { tenantId },
        });
      }
      return existing;
    }

    // Fast path missed it — call the same classify() the background processor
    // uses, then persist so a later webhook pass finds it already done.
    const result = await this.classifierService.classify(text);
    try {
      const created = await this.prisma.generalAnalysis.create({
        data: {
          messageId,
          threadId,
          accountEmail,
          tenantId,
          isUrgent: result.isUrgent,
          urgencyReason: result.urgencyReason,
          intent: result.intent,
          intentConfidence: result.intentConfidence,
          reasoning: result.reasoning,
          promptVersion: CLASSIFIER_PROMPT_VERSION,
          isComplaint: result.isComplaint,
          complaintAbout: result.complaintAbout,
          isFaq: result.isFaq,
        },
      });

      if (tenantId) {
        await this.faqService?.tryAutoReply({
          tenantId,
          accountEmail,
          messageId,
          threadId,
          subject,
          clientEmail,
          emailText: text,
          isFaq: result.isFaq,
          faqConfidence: result.faqConfidence,
          isComplaint: result.isComplaint,
          intent: result.intent,
          analysisId: created.id,
        });
      }

      return created;
    } catch (error) {
      // P2002: background processor beat us in a race — read its row instead.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.prisma.generalAnalysis.findUnique({
          where: { messageId },
        });
        if (raced) return raced;
      }
      throw error;
    }
  }

  async processEmail(
    messageId: string,
    accountEmail: string,
    tenantId: string,
  ) {
    // Normalize once: GA rows store the account email lowercased (OAuth flow),
    // so every comparison and query below must use the same shape — a mixed-case
    // request value would silently miss every stored row.
    accountEmail = accountEmail.trim().toLowerCase();

    // 1. Fetch the raw email once — everything downstream reads from this.
    const parsed = await this.gmailProvider.fetchMessage(
      tenantId,
      messageId,
      accountEmail,
    );
    const emailBody = parsed.textPlain || parsed.textHtml || '';
    const clientEmail = this.extractSenderEmail(parsed.from ?? '');

    // If the opened message is the SE's OWN reply, the thread is already handled.
    // Don't classify our reply or regenerate a draft — tell the panel it's done.
    // (The extension opens the newest message in a thread; once we've replied,
    // that's our outbound message.)
    if (clientEmail && clientEmail === accountEmail) {
      // Read-only summary of what the AI did on this thread, so the panel can
      // show the analysis alongside the "replied" state instead of just "done".
      // Only rows that actually carry supervisor output count — a bare
      // classifier row (null confidences) or a legacy row for our own reply
      // would otherwise shadow the real analysis and render "—".
      const prior = parsed.threadId
        ? await this.prisma.generalAnalysis.findFirst({
            where: {
              threadId: parsed.threadId,
              accountEmail,
              tenantId,
              supervisorLabel: { not: null },
              messageId: { not: messageId },
            },
            orderBy: { createdAt: 'desc' },
          })
        : null;
      return {
        alreadyReplied: true as const,
        summary: prior
          ? {
              intent: prior.intent,
              productConfidence: prior.productConfidence,
              clientHistoryConfidence: prior.clientHistoryConfidence,
              supervisorLabel: prior.supervisorLabel,
            }
          : null,
      };
    }

    // Check if email has the 'salesbox' label
    const salesboxLabelIds = await this.gmailProvider.getSalesboxLabelIds(
      tenantId,
      accountEmail,
    );
    const messageLabelIds = parsed.labelIds ?? [];
    const hasSalesboxLabel =
      salesboxLabelIds.length > 0 &&
      salesboxLabelIds.some((id) => messageLabelIds.includes(id));

    if (!hasSalesboxLabel) {
      this.logger.debug(
        `Message ${messageId} does not have the 'salesbox' label; skipping orchestrator processing`,
      );
      return {
        notSalesbox: true as const,
      };
    }

    await this.clientsService.captureInboundEmail(tenantId, {
      messageId,
      senderEmail: clientEmail,
      senderName: this.extractSenderName(parsed.from ?? ''),
      date: parsed.date,
      subject: parsed.subject,
    });

    // 2. Classifier — cached DB row (fast path) or live classify() (fallback).
    let classification: GeneralAnalysis;
    let classificationSucceeded = true;
    try {
      classification = await this.getOrRunClassification(
        messageId,
        accountEmail,
        tenantId,
        emailBody,
        parsed.threadId || null,
        parsed.subject ?? '',
        clientEmail,
      );
    } catch (error) {
      classificationSucceeded = false;
      this.logger.error(
        `getOrRunClassification failed for message ${messageId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      classification = {
        id: '',
        messageId,
        threadId: null,
        accountEmail,
        tenantId,
        isUrgent: false,
        urgencyReason: 'Classification failed',
        intent: 'support',
        intentConfidence: 0.0,
        reasoning: 'Fallback due to classification failure',
        promptVersion: 'fallback',
        createdAt: new Date(),
        productConfidence: null,
        clientHistoryConfidence: null,
        supervisorLabel: null,
        reviewedAt: null,
        // Classification failed, so nothing was detected — not "we looked and
        // found nothing". Claiming a complaint here would put an email in the
        // admin's escalation feed on the strength of an error.
        isComplaint: false,
        complaintAbout: 'none',
        isFaq: false,
        faqItemId: null,
        faqAutoReplied: false,
      };
    }

    // 3. Load prior history only. The current message was captured above but
    // must not count as evidence that this first-contact sender is known.
    const clientContext = await this.clientsService.getClientContext(
      tenantId,
      clientEmail,
      messageId,
    );

    // 3.5. Fetch ConnectedAccount UUID for LangGraph memory namespaces
    const connectedAccount = await this.prisma.connectedAccount.findFirst({
      where: { tenantId, email: accountEmail },
    });
    const connectedAccountId =
      connectedAccount?.id ?? accountEmail.replace(/[^a-zA-Z0-9_-]/g, '_');

    // 4. Extractor + Composer (Matcher still mocked inside the graph per PR1).
    //    Any failure here is caught so the request NEVER returns a 500 — see §6.
    let draftResult: Awaited<ReturnType<ReplyService['draftReply']>> | null =
      null;
    try {
      draftResult = await this.replyService.draftReply(
        messageId,
        parsed.threadId,
        tenantId,
        connectedAccountId,
        emailBody,
        accountEmail,
        { id: parsed.id ?? messageId, attachments: parsed.attachments ?? [] },
        classification.intent,
        { clientHistory: clientContext.history },
      );
    } catch (error) {
      this.logger.error(
        `draftReply failed for message ${messageId}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      // draftResult stays null — handled below, NOT re-thrown.
    }

    const finalState = draftResult?.state ?? null;

    // 5. Supervisor — pure aggregation, zero LLM calls (PR2).
    //    If draftReply failed we inject a 'hallucinated' claim so computeLabel()
    //    naturally routes to handle_manually instead of crashing the request.
    const supervisorInput: SupervisorInput = {
      classifierOutput: {
        intent: classification.intent,
        intentConfidence: classification.intentConfidence,
        isUrgent: classification.isUrgent,
      },
      extractorOutput: finalState?.extractorResult
        ? {
            featuresInferred: finalState.extractorResult.featuresInferred,
            constraintsInferred: finalState.extractorResult.constraintsInferred,
            scaleInferred: finalState.extractorResult.scaleInferred,
            budgetInferred: finalState.extractorResult.budgetInferred,
            timelineInferred: finalState.extractorResult.timelineInferred,
          }
        : {
            // No extractor output → assume everything inferred (safer: lower confidence).
            featuresInferred: true,
            constraintsInferred: true,
            scaleInferred: true,
            budgetInferred: true,
            timelineInferred: true,
          },
      matcherOutput: {
        matchConfidence: finalState?.matchResult?.confidence ?? 0,
      },
      composerOutput: {
        draftText: finalState?.composerResult?.draftText ?? '',
        claims: finalState?.composerResult?.claims ?? [],
      },
      // Pipeline failure routes to handle_manually the same way a hallucination
      // does, but is reported as its own reason. It used to be signalled by
      // inventing a `hallucinated` claim here — invisible while only the label
      // was consumed, and a plainly false statement once the panel started
      // rendering the reason ("a claim contradicts the KB" with no draft).
      pipelineFailed: !finalState?.composerResult,
      clientHistoryLength: clientContext.historyCount,
      isNewClient: clientContext.isNewClient,
    };

    const supervision = this.supervisorService.supervise(supervisorInput);

    const labelMapping: Record<string, string> = {
      auto_worthy: 'green',
      needs_review: 'yellow',
      handle_manually: 'red',
    };
    const supervisorLabel = labelMapping[supervision.label] || null;

    let updatedClassification: GeneralAnalysis = classification;
    if (classification.id) {
      updatedClassification = await this.prisma.generalAnalysis.update({
        where: { id: classification.id },
        data: {
          productConfidence: supervision.productConfidence,
          clientHistoryConfidence: supervision.clientHistoryConfidence,
          supervisorLabel,
        },
      });
    } else {
      updatedClassification = {
        ...classification,
        productConfidence: supervision.productConfidence,
        clientHistoryConfidence: supervision.clientHistoryConfidence,
        supervisorLabel,
      };
    }

    const targetTenantId = updatedClassification.tenantId || tenantId;
    // A complaint about the sales engineer, or about how the company treated
    // the client, has to reach the admin independently of that engineer. Same
    // rule as the background classifier — this is the other writer, and it
    // reaches emails the webhook has not processed yet.
    const isOversightComplaint =
      updatedClassification.isComplaint &&
      (updatedClassification.complaintAbout === 'person' ||
        updatedClassification.complaintAbout === 'service');

    if (
      updatedClassification.id &&
      targetTenantId &&
      (updatedClassification.isUrgent ||
        updatedClassification.intent === 'sensitive' ||
        updatedClassification.supervisorLabel === 'red' ||
        isOversightComplaint)
    ) {
      const severity =
        updatedClassification.complaintAbout === 'person'
          ? 'high'
          : updatedClassification.isUrgent &&
              updatedClassification.intent === 'sensitive'
            ? 'high'
            : updatedClassification.supervisorLabel === 'red'
              ? 'low'
              : 'medium';
      const existing = await this.prisma.escalationItem
        .findUnique({
          where: { generalAnalysisId: updatedClassification.id },
          select: { severity: true },
        })
        .catch(() => null);

      // Never rolls the pipeline back, but never silent either: a swallowed
      // failure here is what hid the missing escalation_items table.
      try {
        await this.prisma.escalationItem.upsert({
          where: { generalAnalysisId: updatedClassification.id },
          create: {
            tenantId: targetTenantId,
            generalAnalysisId: updatedClassification.id,
            messageId,
            accountEmail,
            severity,
            reason:
              updatedClassification.urgencyReason ||
              updatedClassification.reasoning ||
              'Flagged for attention',
          },
          update: {
            // Only ever raises. This used to write `severity` outright, so an
            // item the classifier had already recorded as high — a complaint
            // naming a person — was quietly demoted to medium or low the
            // moment an SE opened the email, dropping it down the admin's
            // feed. An escalation should not get less serious on re-read.
            severity: raiseSeverity(existing?.severity, severity),
            tenantId: targetTenantId,
          },
        });
      } catch (escalationError) {
        this.logger.error(
          `Escalation write FAILED for message ${messageId} (tenant ${targetTenantId}, severity ${severity}): ` +
            `${escalationError instanceof Error ? escalationError.message : String(escalationError)}. ` +
            'The pipeline result was stored; the admin escalation feed will not show this email.',
        );
      }
    }

    // Enrich the same captured row even when drafting failed. A retry never
    // replaces stronger analysis with fallback classification text.
    await this.clientsService.captureInboundEmail(tenantId, {
      messageId,
      senderEmail: clientEmail,
      senderName: this.extractSenderName(parsed.from ?? ''),
      date: parsed.date,
      subject: parsed.subject,
      aiSummary: classificationSucceeded ? classification.reasoning : null,
      classification: classificationSucceeded ? classification.intent : null,
      productConfidence: supervision.productConfidence,
      clientHistoryConfidence: supervision.clientHistoryConfidence,
    });

    return {
      classification: updatedClassification,
      requirements: finalState?.extractorResult ?? null,
      draft: supervision.draftAvailable
        ? (finalState?.composerResult ?? null)
        : null,
      confidence: supervision,
      graphThreadId: draftResult?.graphThreadId ?? null,
      // The date the email was received (from the message header) so the panel
      // shows the real time instead of falling back to "now".
      emailTimestamp: parsed.date,
      client: {
        name: clientContext.name || null,
        company: clientContext.company || null,
        status: clientContext.status,
        isNewClient: clientContext.isNewClient,
      },
    };
  }

  /**
   * Resumes an interrupted reply graph run with user-edited draft feedback.
   */
  async resumeGraph(
    tenantId: string,
    graphThreadId: string,
    editedContent: string,
  ): Promise<{ memoryUpdated: boolean }> {
    // Deliberately OUTSIDE the try: the catch below turns every failure into a
    // 200 with memoryUpdated:false, which would silently swallow an
    // authorization failure. A caller reaching for another tenant's draft must
    // get a 403, not a quiet no-op.
    assertOwnsGraphThread(tenantId, graphThreadId);
    try {
      const finalState = await this.replyService.resumeWithFeedback(
        tenantId,
        graphThreadId,
        editedContent,
      );
      return { memoryUpdated: Boolean(finalState.memoryUpdated) };
    } catch (error) {
      this.logger.warn(
        `Cannot resume graph ${graphThreadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { memoryUpdated: false };
    }
  }

  /**
   * Fetches raw Gmail message, parses content & sender, and suggests CRM write actions.
   */
  async suggestCrmActions(
    messageId: string,
    accountEmail: string,
    tenantId: string,
  ) {
    accountEmail = accountEmail.trim().toLowerCase();

    const parsed = await this.gmailProvider.fetchMessage(
      tenantId,
      messageId,
      accountEmail,
    );
    const salesboxLabelIds = await this.gmailProvider.getSalesboxLabelIds(
      tenantId,
      accountEmail,
    );
    const messageLabelIds = parsed.labelIds ?? [];
    const hasSalesboxLabel =
      salesboxLabelIds.length > 0 &&
      salesboxLabelIds.some((id) => messageLabelIds.includes(id));

    if (!hasSalesboxLabel) {
      return { isPausedForApproval: false, suggestions: [] };
    }

    const emailContent = parsed.textPlain || parsed.textHtml || '';
    const senderEmail = this.extractSenderEmail(parsed.from ?? '');
    const threadId = parsed.threadId || messageId;

    return this.crmActionsAgent.suggestActions(
      tenantId,
      threadId,
      senderEmail,
      emailContent,
    );
  }

  /**
   * Resumes CRM action execution with human decisions.
   */
  async resumeCrmActions(
    tenantId: string,
    threadId: string,
    decisions: Array<{ type: 'approve' | 'reject'; message?: string }>,
  ) {
    return this.crmActionsAgent.resumeWithDecision(
      tenantId,
      threadId,
      decisions,
    );
  }

  /**
   * Extracts a bare email address from a Gmail `from` header.
   * Handles both `"Name <email@domain.com>"` and plain `"email@domain.com"`.
   */
  private extractSenderEmail(fromHeader: string): string {
    const match = fromHeader.match(/<(.+)>/);
    return (match ? match[1] : fromHeader).trim().toLowerCase();
  }

  private extractSenderName(fromHeader: string): string | undefined {
    const name = fromHeader
      .match(/^\s*(.*?)\s*<[^>]+>/)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '');
    return name || undefined;
  }
}
