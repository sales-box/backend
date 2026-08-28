import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ClientsService } from '../../clients/clients.service';
import { ParsedMessage } from '../../email/email.types';
import { GmailProvider } from '../../email/gmail/gmail-provider.service';
import { FaqService } from '../../faq/faq.service';
import { isMessageGoneError } from './classifier-errors.util';
import { CLASSIFIER_PROMPT_VERSION } from './classifier.constants';
import { ClassifierService } from './classifier.service';
import { prepareEmailText } from './email-text.util';

/**
 * One inbox message, end to end: fetch, capture, classify, store, escalate,
 * and (when the email is FAQ-shaped and a match is found) auto-reply.
 *
 * Lives outside both workers because both need it and there must be exactly
 * one copy. The stored-row check at the top is the exactly-once guarantee that
 * makes the live path and the backlog pass safe to run against one mailbox at
 * the same time; two implementations of it would be two chances to lose that.
 */
@Injectable()
export class MessageClassifier {
  private readonly logger = new Logger(MessageClassifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gmailProvider: GmailProvider,
    private readonly classifier: ClassifierService,
    private readonly clientsService: ClientsService,
    private readonly faqService?: FaqService,
  ) {}

  /** True when this call is the one that stored a new analysis row. */
  async classifyOne(
    messageId: string,
    // `tenantId` is non-null here: callers return early for an account without
    // one, because credentials cannot be resolved without a tenant.
    account: { id: string; email: string; tenantId: string },
  ): Promise<boolean> {
    // Exactly-once rule (design doc §1): the stored row is the cache.
    const existing = await this.prisma.generalAnalysis.findUnique({
      where: { messageId },
    });
    if (existing) return false;

    let parsed: ParsedMessage;
    try {
      parsed = await this.gmailProvider.fetchMessage(
        account.tenantId,
        messageId,
        account.email,
      );
    } catch (error) {
      // Message gone (deleted after the history record) is permanent — skip it,
      // don't let it fail the batch and freeze the baseline. Anything else
      // (auth/network) is transient and propagates to a BullMQ retry.
      if (isMessageGoneError(error)) {
        this.logger.warn('Message no longer retrievable (gone); skipping');
        return false;
      }
      throw error;
    }

    // Verify message has the 'salesbox' label
    const salesboxLabelIds = await this.gmailProvider.getSalesboxLabelIds(
      account.tenantId,
      account.email,
    );
    if (salesboxLabelIds.length > 0) {
      const messageLabelIds = parsed.labelIds ?? [];
      const hasSalesboxLabel = salesboxLabelIds.some((id) =>
        messageLabelIds.includes(id),
      );
      if (!hasSalesboxLabel) {
        this.logger.debug(
          `Message ${messageId} does not have the 'salesbox' label; skipping classification`,
        );
        return false;
      }
    } else {
      this.logger.warn(
        `Account ${account.email} does not have a 'salesbox' label created in Gmail; skipping classification`,
      );
      return false;
    }

    // Skip the SE's own outbound messages (replies we sent). Gmail threads them
    // into the conversation, but classifying them inflates the processed count
    // and mislabels our own reply as an inbound "follow-up".
    const fromRaw = parsed.from ?? '';
    const fromEmail = (fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw)
      .trim()
      .toLowerCase();
    if (fromEmail && fromEmail === account.email.trim().toLowerCase()) {
      this.logger.debug(
        'SE-authored (outbound) message; skipping classification',
      );
      return false;
    }

    const hasValidSender = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail);
    if (!hasValidSender) {
      this.logger.warn('Message has no valid sender email; skipping capture');
    }
    if (!account.tenantId) {
      this.logger.warn('Connected account has no tenant; skipping capture');
    }

    // Capture before any AI work so an empty body, provider outage, or worker
    // retry can never lose the first inbound touchpoint.
    if (account.tenantId && hasValidSender) {
      await this.clientsService.captureInboundEmail(account.tenantId, {
        messageId,
        senderEmail: fromEmail,
        senderName: this.extractSenderName(fromRaw),
        date: parsed.date,
        subject: parsed.subject,
      });
    }

    // The subject carries strong intent/urgency signal ("URGENT: ...",
    // "cancelling our contract") and is sometimes the ONLY content, so it is
    // classified alongside the body (both caged as untrusted by classify()).
    const body = prepareEmailText(parsed.textPlain, parsed.textHtml);
    const subject = (parsed.subject ?? '').trim();
    const text = subject ? `Subject: ${subject}\n\n${body}`.trim() : body;
    if (text.length === 0) {
      this.logger.warn('Message has no classifiable text; skipping');
      return false;
    }

    const result = await this.classifier.classify(text);

    if (account.tenantId && hasValidSender) {
      await this.clientsService.captureInboundEmail(account.tenantId, {
        messageId,
        senderEmail: fromEmail,
        senderName: this.extractSenderName(fromRaw),
        date: parsed.date,
        subject: parsed.subject,
        aiSummary: result.reasoning,
        classification: result.intent,
      });
    }

    try {
      const created = await this.prisma.generalAnalysis.create({
        data: {
          messageId,
          threadId: parsed.threadId || null,
          accountEmail: account.email,
          tenantId: account.tenantId,
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

      // ── FAQ auto-reply ──────────────────────────────────────────────────────
      const emailText =
        prepareEmailText(parsed.textPlain, parsed.textHtml) ||
        (parsed.subject ?? '');
      const clientEmail =
        (parsed.from ?? '').match(/<([^>]+)>/)?.[1]?.trim() ??
        parsed.from ??
        '';

      await this.faqService?.tryAutoReply({
        tenantId: account.tenantId,
        accountEmail: account.email,
        messageId,
        threadId: parsed.threadId || null,
        subject: parsed.subject ?? '',
        clientEmail,
        emailText,
        isFaq: result.isFaq,
        faqConfidence: result.faqConfidence,
        isComplaint: result.isComplaint,
        intent: result.intent,
        analysisId: created.id,
      });

      // ── Escalation ──────────────────────────────────────────────────────────
      // the client, has to reach the admin on its own account. Routed only to
      // the SE's inbox, the person being complained about is the one who
      // decides whether anyone else ever hears about it — which is exactly the
      // oversight this product is supposed to provide.
      const isOversightComplaint =
        result.isComplaint &&
        (result.complaintAbout === 'person' ||
          result.complaintAbout === 'service');

      if (
        created?.id &&
        account.tenantId &&
        (result.isUrgent ||
          result.intent === 'sensitive' ||
          isOversightComplaint)
      ) {
        // A complaint naming the individual outranks everything: it is the one
        // case where the usual routing has a conflict of interest built in.
        const severity =
          result.complaintAbout === 'person'
            ? 'high'
            : result.isUrgent && result.intent === 'sensitive'
              ? 'high'
              : 'medium';
        // The classification itself is already stored and must not be rolled
        // back by a failed escalation write — but the failure has to be
        // audible. This used to be `.catch(() => {})`, which is how the whole
        // feature ran for weeks against a database that had no
        // escalation_items table at all, reporting success every time.
        try {
          await this.prisma.escalationItem.upsert({
            where: { generalAnalysisId: created.id },
            create: {
              tenantId: account.tenantId,
              generalAnalysisId: created.id,
              messageId,
              accountEmail: account.email,
              severity,
              reason: result.urgencyReason || result.reasoning,
            },
            update: {},
          });
        } catch (escalationError) {
          this.logger.error(
            `Escalation write FAILED for message ${messageId} (tenant ${account.tenantId}, severity ${severity}): ` +
              `${escalationError instanceof Error ? escalationError.message : String(escalationError)}. ` +
              'The classification was stored; the admin escalation feed will not show this email.',
          );
        }
      }
    } catch (error) {
      // P2002: a concurrent worker stored it first — the result exists, done.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }
    return true;
  }

  private extractSenderName(from: string): string | undefined {
    const name = from
      .match(/^\s*(.*?)\s*<[^>]+>/)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '');
    return name || undefined;
  }
}
