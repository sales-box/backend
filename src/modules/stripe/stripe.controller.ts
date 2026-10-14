import {
  Controller,
  Headers,
  Post,
  Req,
  HttpCode,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import * as fastify from 'fastify';
import Stripe from 'stripe';
import { StripeService } from './stripe.service';
import { PaymentService } from '../payments/payment.service';
import {
  ApiTags,
  ApiOperation,
  ApiHeader,
  ApiOkResponse,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '@/database/prisma.service';

interface RequestWithRawBody extends fastify.FastifyRequest {
  rawBody?: Buffer;
}

@ApiTags('stripe')
@SkipThrottle()
@Controller('stripe')
export class StripeController {
  private readonly logger = new Logger(StripeController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly paymentsService: PaymentService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('webhook')
  @ApiOperation({
    summary: 'Stripe webhook receiver (called by Stripe, not interactively)',
    description:
      'Signature-verified against STRIPE_WEBHOOK_SECRET. Handles subscription ' +
      'lifecycle events: checkout.session.completed, invoice.paid, ' +
      'invoice.payment_failed, customer.subscription.deleted, charge.refunded.',
  })
  @ApiHeader({
    name: 'stripe-signature',
    description: 'Stripe signature header',
    required: true,
  })
  @ApiOkResponse({ description: 'Event received and processed.' })
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
      throw new BadRequestException(`Webhook Error: ${message}`);
    }

    // Idempotency: skip events already processed.
    const existing = await this.prisma.processedStripeEvent.findUnique({
      where: { eventId: event.id },
    });
    if (existing) {
      this.logger.log(`Skipping already-processed event: ${event.id}`);
      return { received: true };
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await this.paymentsService.handleCheckoutCompleted(event.data.object);
        break;

      case 'invoice.paid':
        await this.paymentsService.handleInvoicePaid(event.data.object);
        break;

      case 'invoice.payment_failed':
        await this.paymentsService.handleInvoicePaymentFailed(
          event.data.object,
        );
        break;

      case 'customer.subscription.deleted':
        await this.paymentsService.handleSubscriptionDeleted(event.data.object);
        break;

      case 'charge.refunded':
        await this.paymentsService.handleChargeRefunded(event.data.object);
        break;

      default:
        this.logger.log(`Unhandled Stripe event: ${event.type}`);
    }

    // Record this event so retries are idempotent.
    await this.prisma.processedStripeEvent.create({
      data: { eventId: event.id, eventType: event.type },
    });

    return { received: true };
  }
}
