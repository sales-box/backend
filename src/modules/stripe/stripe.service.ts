import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  constructor() {}

  readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: process.env
      .STRIPE_API_VERSION as Stripe.StripeConfig['apiVersion'],
  });

  async createPaymentIntent(tenantId: string, amount: number, tier?: number) {
    return this.stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      metadata: {
        tenantId,
        ...(tier != null && { tier: String(tier) }),
      },
    });
  }

  async getPayment(tenantId: string, id: string) {
    const paymentIntent = await this.stripe.paymentIntents.retrieve(id);
    if (paymentIntent.metadata?.tenantId !== tenantId) {
      throw new Error('Payment intent not found or tenant mismatch');
    }
    return paymentIntent;
  }
}
