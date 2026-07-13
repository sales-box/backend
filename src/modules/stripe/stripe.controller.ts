import { Controller, Headers, Post, Req, HttpCode } from '@nestjs/common';
import * as fastify from 'fastify';

import Stripe from 'stripe';
import { StripeService } from './stripe.service';
import { PaymentService } from '../payments/payment.service';
import { ApiTags } from '@nestjs/swagger';

interface RequestWithRawBody extends fastify.FastifyRequest {
  rawBody?: Buffer;
}

@ApiTags('stripe')
@Controller('stripe')
export class StripeController {
  constructor(
    private readonly stripeService: StripeService,
    private readonly paymentsService: PaymentService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() request: RequestWithRawBody,
    @Headers('stripe-signature') signature: string,
  ) {
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;

    let event: Stripe.Event;

    const rawBody = request.rawBody;
    if (!rawBody) {
      throw new Error('Webhook Error: Missing raw body buffer');
    }

    try {
      event = this.stripeService.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        endpointSecret,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Webhook Error: ${message}`);
    }

    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.handlePaymentSucceeded(event);
        break;

      case 'payment_intent.payment_failed':
        await this.handlePaymentFailed(event);
        break;

      case 'charge.refunded':
        this.handleRefund(event);
        break;

      default:
        console.log(`Unhandled event: ${event.type}`);
    }

    return {
      received: true,
    };
  }

  private async handlePaymentSucceeded(event: Stripe.Event) {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;

    await this.paymentsService.paymentSucceeded(paymentIntent);
  }

  private async handlePaymentFailed(event: Stripe.Event) {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;

    await this.paymentsService.paymentFailed(paymentIntent);
  }

  private handleRefund(event: Stripe.Event) {
    console.log(`Refund received for event: ${event.id}`);
  }
}
