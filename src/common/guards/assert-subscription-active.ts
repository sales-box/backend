import { ForbiddenException, SetMetadata } from '@nestjs/common';
import { PrismaService } from '@/database/prisma.service';

/**
 * Route- or controller-level opt-out of the paywall, for the handful of
 * endpoints an unpaid tenant legitimately needs.
 *
 * Keep this list short and justify every addition. The paywall is enforced in
 * JwtAuthGuard rather than in a guard each controller must remember to add,
 * precisely so that forgetting something fails closed (locked) instead of open
 * (free product). Marking a route with this decorator is the only way to open
 * it, which makes every hole in the paywall greppable.
 */
export const NO_SUBSCRIPTION_REQUIRED = 'noSubscriptionRequired';
export const NoSubscriptionRequired = () =>
  SetMetadata(NO_SUBSCRIPTION_REQUIRED, true);

/** The one subscription state that unlocks the product. */
const PAID = 'active';

/**
 * Rejects a request whose owning tenant has not paid.
 *
 * This is the paywall. SalesBox has no free tier, so signing up and verifying
 * an email buys nothing: it sets `tenant.status = 'active'`, which means "this
 * account exists and is not suspended", not "this company is a customer".
 * Only the Stripe webhook sets `subscriptionStatus = 'active'`.
 *
 * The two fields are checked together in one query because they fail the same
 * way from the caller's point of view but for different reasons, and the
 * message has to distinguish them — an operator-suspended customer who is
 * paying must not be told to go and pay again.
 */
export async function assertSubscriptionActive(
  prisma: PrismaService,
  tenantId: string,
): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true, subscriptionStatus: true },
  });

  if (!tenant) {
    throw new ForbiddenException('This account is not active');
  }

  // Account lifecycle first: a suspended tenant is blocked whether or not the
  // card is good, and telling them their subscription lapsed would be a lie.
  if (tenant.status !== 'active') {
    throw new ForbiddenException('This account is not active');
  }

  if (tenant.subscriptionStatus !== PAID) {
    // The code is what the dashboard switches on to decide which screen to
    // show: a first-time checkout, or a "your payment failed" recovery prompt.
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: 'SUBSCRIPTION_REQUIRED',
      subscriptionStatus: tenant.subscriptionStatus,
      message:
        tenant.subscriptionStatus === 'none'
          ? 'This workspace has no active subscription. Choose a plan to get started.'
          : 'Your subscription is no longer active. Update your payment details to restore access.',
    });
  }
}
