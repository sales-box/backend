import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PLANS } from '../payments/plans';
import Stripe from 'stripe';
import { PrismaService } from '@/database/prisma.service';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);

  readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: process.env
      .STRIPE_API_VERSION as Stripe.StripeConfig['apiVersion'],
  });

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Get or create a Stripe Customer for this tenant, so every checkout and
   * subscription rolls up under one customer record in Stripe.
   */
  async getOrCreateCustomer(tenantId: string, email: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeCustomerId: true, companyName: true },
    });

    if (tenant?.stripeCustomerId) {
      return tenant.stripeCustomerId;
    }

    const customer = await this.stripe.customers.create({
      email,
      name: tenant?.companyName ?? undefined,
      metadata: { tenantId },
    });

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { stripeCustomerId: customer.id },
    });

    return customer.id;
  }

  /**
   * Creates a Stripe Checkout Session in `subscription` mode.
   *
   * The frontend redirects the user to the returned `url`. After payment,
   * Stripe redirects back to `success_url`. The webhook handles activation —
   * the frontend polls `GET /tenants/:id` until `subscriptionStatus` flips.
   */
  async createCheckoutSession(
    tenantId: string,
    tier: number,
    email: string,
  ): Promise<{ sessionId: string; url: string }> {
    const plan = PLANS[tier];
    if (!plan) {
      throw new BadRequestException(
        'That plan cannot be purchased online. Please contact sales.',
      );
    }

    if (!plan.stripePriceId) {
      throw new BadRequestException(
        `Stripe Price not configured for tier ${tier}. Set STRIPE_PRICE_STARTER / STRIPE_PRICE_GROWTH in your environment.`,
      );
    }

    const customerId = await this.getOrCreateCustomer(tenantId, email);

    // FRONTEND_DASHBOARD_URL may include a path suffix like /callback (used by
    // the OAuth flow). We only need the origin for Stripe redirect URLs.
    const rawUrl = this.config.getOrThrow<string>('FRONTEND_DASHBOARD_URL');
    const baseUrl = new URL(rawUrl).origin;

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      metadata: { tenantId, tier: String(tier) },
      subscription_data: {
        metadata: { tenantId, tier: String(tier) },
      },
      success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/checkout?plan=${tier}&canceled=1`,
    });

    return { sessionId: session.id, url: session.url! };
  }

  async getCheckoutSession(sessionId: string, tenantId: string) {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    if (session.metadata?.tenantId !== tenantId) {
      throw new NotFoundException(
        'Checkout session not found or tenant mismatch',
      );
    }
    return session;
  }
}
