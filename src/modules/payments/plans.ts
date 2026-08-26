/**
 * What each plan costs and its Stripe Price, decided here and nowhere else.
 *
 * `STRIPE_PRICE_IDS` maps each tier to a RECURRING Stripe Price (monthly).
 * These must be created in the Stripe dashboard (or via the API) BEFORE the
 * checkout works. The values come from env vars so test/live keys never mix.
 *
 * `PLAN_PRICES` is kept for display and validation purposes only — Stripe owns
 * the authoritative price via the Price object.
 */

export interface PlanConfig {
  priceCents: number;
  stripePriceId: string;
}

export const PLANS: Readonly<Record<number, PlanConfig>> = Object.freeze({
  1: {
    priceCents: 4_900,
    stripePriceId: process.env.STRIPE_PRICE_STARTER!,
  },
  2: {
    priceCents: 14_900,
    stripePriceId: process.env.STRIPE_PRICE_GROWTH!,
  },
});

/**
 * Enterprise is deliberately absent above. It is quoted per customer, so there
 * is no self-serve price to charge and the checkout must not invent one.
 */
export const SELF_SERVE_TIERS = Object.freeze(Object.keys(PLANS).map(Number));

/** Legacy re-export — some tests reference PLAN_PRICES directly. */
export const PLAN_PRICES: Readonly<Record<number, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(PLANS).map(([k, v]) => [Number(k), v.priceCents]),
  ),
);

export const PLAN_CURRENCY = 'usd';
