export const INTENTS = [
  'product inquiry',
  'demo request',
  'support',
  'follow-up',
  'sensitive',
] as const;

export type Intent = (typeof INTENTS)[number];

/**
 * Who or what a complaint is about — the distinction that decides where it goes.
 *
 * A complaint about the product is a support problem and belongs with the SE
 * handling the account. A complaint about the SE, or about the company's
 * conduct, cannot only go there: the person being complained about would be the
 * one deciding whether anyone hears it. That is why this is separate from
 * `intent` rather than another intent value — the same email is often both a
 * support ticket and something the admin needs to see independently.
 */
export const COMPLAINT_TARGETS = [
  'product',
  'service',
  'person',
  'none',
] as const;

export type ComplaintTarget = (typeof COMPLAINT_TARGETS)[number];

/** The stored contract — the exact shape CONTRACTS.md promises the Extractor. */
export interface ClassificationResult {
  isUrgent: boolean;
  urgencyReason: string | null;
  intent: Intent;
  intentConfidence: number;
  /** Model's own audit trail; stored for debugging/eval, not part of the contract. */
  reasoning: string;
  /** True when the client is unhappy, not merely asking for something. */
  isComplaint: boolean;
  /** What the complaint is about. 'none' whenever isComplaint is false. */
  complaintAbout: ComplaintTarget;
}

export interface ClassifyEmailJobData {
  emailAddress: string;
  historyId: string;
}

export interface ClassifyJobResult {
  classified: number;
  skipped?: 'no_account' | 'no_baseline' | 'history_expired';
}
