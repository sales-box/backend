/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
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

  async createPaymentIntent(tenantId: string, amount: number, tier?: number) {
    const paymentIntent = await this.stripeService.createPaymentIntent(
      tenantId,
      amount,
      tier,
    );
    return paymentIntent;
  }

  async getPayment(tenantId: string, id: string) {
    const paymentIntent = await this.stripeService.getPayment(tenantId, id);
    return paymentIntent;
  }

  async paymentSucceeded(paymentIntent: Stripe.PaymentIntent) {
    const tenantId = paymentIntent.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn(
        `Payment succeeded without tenant ID in metadata. ID: ${paymentIntent.id}`,
      );
      return;
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      this.logger.error(
        `Payment succeeded for non-existent tenant: ${tenantId}. ID: ${paymentIntent.id}`,
      );
      return;
    }

    const tier = paymentIntent.metadata?.tier
      ? Number(paymentIntent.metadata.tier)
      : undefined;

    if (tier && [1, 2, 3].includes(tier)) {
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { tier },
      });
      this.logger.log(`Tenant ${tenantId} upgraded to tier ${tier}`);
    }

    this.logger.log(
      `Payment succeeded for tenant ${tenant.companyName} (${tenantId}). Amount: ${paymentIntent.amount / 100} USD. PaymentIntent ID: ${paymentIntent.id}`,
    );
  }

  async paymentFailed(paymentIntent: Stripe.PaymentIntent) {
    const tenantId = paymentIntent.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn(
        `Payment failed without tenant ID in metadata. ID: ${paymentIntent.id}`,
      );
      return;
    }

    this.logger.error(
      `Payment failed for tenant: ${tenantId}. ID: ${paymentIntent.id}`,
    );
    await Promise.resolve();
  }
}
