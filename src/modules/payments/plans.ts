/**
 * What each plan costs, decided here and nowhere else.
 *
 * The price and the tier both used to arrive in the request body and were
 * copied straight into Stripe metadata, and the webhook then wrote
 * `tenant.tier` from that metadata. So the buyer chose their own price: a
 * tier-3 payment intent for one dollar was a single curl away, and the webhook
 * would happily upgrade the tenant when it settled.
 *
 * Amounts are in the smallest currency unit (cents) and must stay in step with
 * the pricing the dashboard advertises in
 * `frontend/apps/dashboard/src/data/pricingTiers.ts`.
 */
export const PLAN_PRICES: Readonly<Record<number, number>> = Object.freeze({
  1: 4_900, // Starter — $49/mo
  2: 14_900, // Growth  — $149/mo
});

/**
 * Enterprise is deliberately absent above. It is quoted per customer, so there
 * is no self-serve price to charge and the checkout must not invent one.
 */
export const SELF_SERVE_TIERS = Object.freeze(
  Object.keys(PLAN_PRICES).map(Number),
);

export const PLAN_CURRENCY = 'usd';
