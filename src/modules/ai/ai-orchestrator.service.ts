import { Injectable, Logger } from '@nestjs/common';
import { Prisma, GeneralAnalysis } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { GmailProvider } from '@/modules/email/gmail/gmail-provider.service';
import { ClassifierService } from '@/modules/ai/classifier/classifier.service';
import { CLASSIFIER_PROMPT_VERSION } from '@/modules/ai/classifier/classifier.constants';
import { ClientsService } from '@/modules/clients/clients.service';
import { ReplyService } from '@/modules/ai/graphs/reply/reply.service';
import { SupervisorService } from '@/modules/ai/supervisor/supervisor.service';
import { SupervisorInput } from '@/modules/ai/supervisor/supervisor.types';

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
  ) {
    const existing = await this.prisma.generalAnalysis.findUnique({
      where: { messageId },
    });
    if (existing) return existing;

    // Fast path missed it — call the same classify() the background processor
    // uses, then persist so a later webhook pass finds it already done.
    const result = await this.classifierService.classify(text);
    try {
      return await this.prisma.generalAnalysis.create({
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
        },
      });
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
    // 1. Fetch the raw email once — everything downstream reads from this.
    const parsed = await this.gmailProvider.fetchMessage(
      messageId,
      accountEmail,
    );
    const emailBody = parsed.textPlain || parsed.textHtml || '';
    const clientEmail = this.extractSenderEmail(parsed.from ?? '');

    // If the opened message is the SE's OWN reply, the thread is already handled.
    // Don't classify our reply or regenerate a draft — tell the panel it's done.
    // (The extension opens the newest message in a thread; once we've replied,
    // that's our outbound message.)
    if (clientEmail && clientEmail === accountEmail.trim().toLowerCase()) {
      // Read-only summary of what the AI did on this thread (the client's stored
      // row), so the panel can show the analysis alongside the "replied" state
      // instead of just "done".
      const prior = parsed.threadId
        ? await this.prisma.generalAnalysis.findFirst({
            where: { threadId: parsed.threadId, accountEmail, tenantId },
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

    // 2. Classifier — cached DB row (fast path) or live classify() (fallback).
    let classification: GeneralAnalysis;
    try {
      classification = await this.getOrRunClassification(
        messageId,
        accountEmail,
        tenantId,
        emailBody,
        parsed.threadId || null,
      );
    } catch (error) {
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
      };
    }

    // 3. Client history — zero new code, already-existing service.
    const clientContext = await this.clientsService.getClientContext(
      tenantId,
      clientEmail,
    );

    // 4. Extractor + Composer (Matcher still mocked inside the graph per PR1).
    //    Any failure here is caught so the request NEVER returns a 500 — see §6.
    let finalState: Awaited<ReturnType<ReplyService['draftReply']>> | null =
      null;
    try {
      finalState = await this.replyService.draftReply(
        messageId,
        tenantId,
        emailBody,
        accountEmail,
        { id: parsed.id ?? messageId, attachments: parsed.attachments ?? [] },
        classification.intent,
      );
    } catch (error) {
      this.logger.error(
        `draftReply failed for message ${messageId}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      // finalState stays null — handled below, NOT re-thrown.
    }

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
        // Pipeline failure → inject a hallucinated claim so the Supervisor
        // veto (PR2) routes to handle_manually without duplicating that logic.
        claims: finalState?.composerResult?.claims ?? [
          { status: 'hallucinated' },
        ],
      },
      clientHistoryLength: clientContext.history.length,
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

    // Auto-log this email as a client interaction so history confidence builds
    // over time. Deduped per Gmail message, so re-processing/refreshing the same
    // email updates (not duplicates) it. Only for identified clients — a stranger
    // has no client row to attach to yet (they still get the new-client baseline).
    if (clientContext.clientId) {
      try {
        await this.prisma.interaction.upsert({
          where: { tenant_message: { tenantId, messageId } },
          create: {
            tenantId,
            clientId: clientContext.clientId,
            messageId,
            date: parsed.date ? new Date(parsed.date) : new Date(),
            type: 'email',
            subject: parsed.subject || '(no subject)',
            aiSummary: classification.reasoning || '',
            classification: classification.intent,
            productConfidence: supervision.productConfidence,
            clientHistoryConfidence: supervision.clientHistoryConfidence,
          },
          update: {
            productConfidence: supervision.productConfidence,
            clientHistoryConfidence: supervision.clientHistoryConfidence,
          },
        });
      } catch (error) {
        this.logger.warn(
          `Failed to log interaction for message ${messageId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      classification: updatedClassification,
      requirements: finalState?.extractorResult ?? null,
      draft: supervision.draftAvailable
        ? (finalState?.composerResult ?? null)
        : null,
      confidence: supervision,
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
   * Extracts a bare email address from a Gmail `from` header.
   * Handles both `"Name <email@domain.com>"` and plain `"email@domain.com"`.
   */
  private extractSenderEmail(fromHeader: string): string {
    const match = fromHeader.match(/<(.+)>/);
    return (match ? match[1] : fromHeader).trim().toLowerCase();
  }
}
