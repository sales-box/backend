export type AnalyticsSummary = {
  totalEmailsProcessed: number;
  byClassification: Record<string, number>;
  averageConfidence: number;
  lowConfidenceCount: number;
};

// One row per allowlisted SE for a tenant. Backs GET /analytics/team.
// - status/grantedAt/verifiedAt come from AllowlistEntry (one-time badge-in).
// - lastLoginAt comes from ConnectedAccount, updated on every login.
// - emailsReceived/repliesSent/replyRate come from GeneralAnalysis, keyed by
//   accountEmail: repliesSent counts rows where reviewedAt is set, which is
//   only stamped when the Gmail history diff detects an actual SENT message
//   on the thread (see ClassifierProcessor.fetchNewSentThreadIds) — not when
//   the SE merely opens the email.
export type TeamMemberStats = {
  email: string;
  status: string; // 'granted' | 'verified' | 'revoked'
  grantedAt: Date;
  verifiedAt: Date | null;
  lastLoginAt: Date | null;
  emailsReceived: number;
  repliesSent: number;
  replyRate: number; // repliesSent / emailsReceived, 0 when emailsReceived is 0
};
