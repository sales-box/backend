import { type ClientStatus, isClientStatus } from '../clients/client-status';

/**
 * HubSpot's stock lifecycle stages, mapped onto our own status ladder.
 *
 * A portal can also define custom stages, which arrive as numeric internal IDs
 * rather than these labels. Those map to nothing on purpose: guessing would be
 * worse than leaving the client where it already sits, so an unknown stage
 * returns undefined and the caller keeps the existing value.
 */
const LIFECYCLE_TO_STATUS: Readonly<Record<string, ClientStatus>> = {
  subscriber: 'new_inquiry',
  lead: 'new_inquiry',
  marketingqualifiedlead: 'qualified',
  salesqualifiedlead: 'qualified',
  opportunity: 'opportunity',
  customer: 'customer',
  evangelist: 'customer',
  other: 'new_inquiry',
};

export function statusFromLifecycleStage(
  stage?: string | null,
): ClientStatus | undefined {
  if (!stage) return undefined;
  const mapped = LIFECYCLE_TO_STATUS[stage.trim().toLowerCase()];
  // isClientStatus also blocks Object.prototype keys ('constructor', 'toString'),
  // which the lookup would otherwise resolve to a function.
  return isClientStatus(mapped) ? mapped : undefined;
}
