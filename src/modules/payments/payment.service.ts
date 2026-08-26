import { Injectable, Logger } from '@nestjs/common';
import { StripeService } from '../stripe/stripe.service';
import Stripe from 'stripe';
import { PrismaService } from '@/database/prisma.service';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly prisma: PrismaService,
  ) {}

  async createCheckoutSession(tenantId: string, tier: number, email: string) {
    return this.stripeService.createCheckoutSession(tenantId, tier, email);
  }

  async getCheckoutSession(sessionId: string, tenantId: string) {
    return this.stripeService.getCheckoutSession(sessionId, tenantId);
  }

  /**
   * `checkout.session.completed` — the customer just finished paying.
   *
   * This is the ONLY path that sets `subscriptionStatus: 'active'` for a new
   * subscriber. It also writes `tier`, `subscribedAt`, and `stripeCustomerId`.
   */
  async handleCheckoutCompleted(session: Stripe.Checkout.Session) {
    const tenantId = session.metadata?.tenantId;
    const tier = session.metadata?.tier
      ? Number(session.metadata.tier)
      : undefined;

    if (!tenantId) {
      this.logger.warn(
        `checkout.session.completed without tenantId. Session: ${session.id}`,
      );
      return;
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      this.logger.error(
        `checkout.session.completed for non-existent tenant: ${tenantId}`,
      );
      return;
    }

    const updateData: Record<string, unknown> = {
      subscriptionStatus: 'active',
      subscribedAt: tenant.subscribedAt ?? new Date(),
    };

    if (tier && [1, 2, 3].includes(tier)) {
      updateData.tier = tier;
    }

    if (session.customer && typeof session.customer === 'string') {
      updateData.stripeCustomerId = session.customer;
    }

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: updateData,
    });

    this.logger.log(
      `Tenant ${tenantId} subscription activated (tier ${tier}). Session: ${session.id}`,
    );
  }

  /**
   * `invoice.paid` — a recurring payment succeeded.
   *
   * For the first invoice this is redundant with `checkout.session.completed`,
   * but for renewals it is the signal that the subscription is still healthy.
   * If the tenant was `past_due`, this restores them.
   */
  async handleInvoicePaid(invoice: Stripe.Invoice) {
    const tenantId = await this.resolveTenantIdFromInvoice(invoice);
    if (!tenantId) return;

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { subscriptionStatus: true },
    });

    if (!tenant) {
      this.logger.warn(
        `invoice.paid for non-existent tenant: ${tenantId}. Invoice: ${invoice.id}`,
      );
      return;
    }

    if (tenant.subscriptionStatus !== 'active') {
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { subscriptionStatus: 'active' },
      });
      this.logger.log(
        `Tenant ${tenantId} restored to active after invoice.paid. Invoice: ${invoice.id}`,
      );
    }
  }

  /**
   * `invoice.payment_failed` — a renewal charge failed.
   *
   * Sets `past_due` only if the tenant was previously `active`. A tenant that
   * was already `canceled` or `none` should not be promoted to `past_due`.
   */
  async handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
    const tenantId = await this.resolveTenantIdFromInvoice(invoice);
    if (!tenantId) return;

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { subscriptionStatus: true },
    });

    if (!tenant) {
      this.logger.warn(
        `invoice.payment_failed for non-existent tenant: ${tenantId}. Invoice: ${invoice.id}`,
      );
      return;
    }

    if (tenant.subscriptionStatus === 'active') {
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { subscriptionStatus: 'past_due' },
      });
      this.logger.log(
        `Tenant ${tenantId} set to past_due. Invoice: ${invoice.id}`,
      );
    }
  }

  /**
   * `customer.subscription.deleted` — subscription canceled or expired.
   */
  async handleSubscriptionDeleted(subscription: Stripe.Subscription) {
    const tenantId = subscription.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn(
        `customer.subscription.deleted without tenantId. Sub: ${subscription.id}`,
      );
      return;
    }

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { subscriptionStatus: 'canceled' },
    });

    this.logger.log(
      `Tenant ${tenantId} subscription canceled. Sub: ${subscription.id}`,
    );
  }

  /**
   * `charge.refunded` — only full refunds cancel. Partial refunds are logged.
   */
  async handleChargeRefunded(charge: Stripe.Charge) {
    if (!charge.refunded) {
      this.logger.log(
        `Partial refund on charge ${charge.id}, no state change.`,
      );
      return;
    }

    const customerId =
      typeof charge.customer === 'string' ? charge.customer : null;
    if (!customerId) {
      this.logger.warn(
        `charge.refunded without customer. Charge: ${charge.id}`,
      );
      return;
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { stripeCustomerId: customerId },
      select: { id: true },
    });

    if (!tenant) {
      this.logger.warn(
        `charge.refunded for unknown customer: ${customerId}. Charge: ${charge.id}`,
      );
      return;
    }

    await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: { subscriptionStatus: 'canceled' },
    });

    this.logger.log(
      `Tenant ${tenant.id} canceled after full refund. Charge: ${charge.id}`,
    );
  }

  /**
   * Resolve tenantId from an invoice via the customer id.
   *
   * `invoice.subscription` is a string id, not an expanded object, so we
   * cannot read subscription metadata directly. The customer lookup is the
   * reliable path — every checkout session creates/links a Stripe Customer
   * with a matching `stripeCustomerId` on our Tenant row.
   */
  private async resolveTenantIdFromInvoice(
    invoice: Stripe.Invoice,
  ): Promise<string | undefined> {
    const customerId =
      typeof invoice.customer === 'string' ? invoice.customer : null;
    if (!customerId) {
      this.logger.warn(`Invoice ${invoice.id}: no customer on invoice.`);
      return undefined;
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { stripeCustomerId: customerId },
      select: { id: true },
    });

    if (!tenant) {
      this.logger.warn(
        `Invoice ${invoice.id}: customer ${customerId} not found in tenants.`,
      );
      return undefined;
    }

    return tenant.id;
  }
}
