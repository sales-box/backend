/**
 * The vocabulary of `Client.status`.
 *
 * The column is a plain `String` with no enum behind it, and until now exactly
 * one value was ever written — every client, imported or inbound, landed on
 * `new_inquiry` and stayed there. These four values are the ladder a client
 * actually climbs; `new_inquiry` remains the floor so nothing that already
 * exists changes meaning.
 */
export const CLIENT_STATUSES = [
  'new_inquiry',
  'qualified',
  'opportunity',
  'customer',
] as const;

export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/** Where a client starts when nothing better is known. */
export const DEFAULT_CLIENT_STATUS: ClientStatus = 'new_inquiry';

export function isClientStatus(value: unknown): value is ClientStatus {
  return (
    typeof value === 'string' &&
    (CLIENT_STATUSES as readonly string[]).includes(value)
  );
}
