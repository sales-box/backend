export const INTENTS = [
  'product inquiry',
  'demo request',
  'support',
  'follow-up',
  'sensitive',
] as const;

export type Intent = (typeof INTENTS)[number];

/** The stored contract — the exact shape CONTRACTS.md promises the Extractor. */
export interface ClassificationResult {
  isUrgent: boolean;
  urgencyReason: string | null;
  intent: Intent;
  intentConfidence: number;
  /** Model's own audit trail; stored for debugging/eval, not part of the contract. */
  reasoning: string;
}

export interface ClassifyEmailJobData {
  emailAddress: string;
  historyId: string;
}

export interface ClassifyJobResult {
  classified: number;
  skipped?: 'no_account' | 'no_baseline' | 'history_expired';
}
