import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PLAN_CURRENCY, PLAN_PRICES } from '../payments/plans';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  constructor() {}

  readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: process.env
      .STRIPE_API_VERSION as Stripe.StripeConfig['apiVersion'],
  });

  /**
   * The amount comes from the server-side plan table, never from the caller.
   * It used to be a request-body field that was passed through to Stripe and
   * echoed into metadata, and the webhook writes `tenant.tier` from that
   * metadata — so a buyer could pay one dollar for the top plan.
   */
  async createPaymentIntent(tenantId: string, tier: number) {
    const amount = PLAN_PRICES[tier];
    if (amount === undefined) {
      throw new BadRequestException(
        'That plan cannot be purchased online. Please contact sales.',
      );
    }

    return this.stripe.paymentIntents.create({
      amount,
      currency: PLAN_CURRENCY,
      metadata: { tenantId, tier: String(tier) },
    });
  }

  async getPayment(tenantId: string, id: string) {
    const paymentIntent = await this.stripe.paymentIntents.retrieve(id);
    if (paymentIntent.metadata?.tenantId !== tenantId) {
      throw new NotFoundException(
        'Payment intent not found or tenant mismatch',
      );
    }
    return paymentIntent;
  }
}
