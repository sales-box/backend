export type AnalyticsSummary = {
  totalEmailsProcessed: number;
  byClassification: Record<string, number>;
  // Average over the AI-reviewed subset only (confidence is written just for
  // emails an SE opened via /ai/process). 0 when the subset is empty.
  averageConfidence: number;
  // Back-compat alias for the old dashboard: mirrors aiReviewed.escalated.
  lowConfidenceCount: number;
  // Month-over-month change in processed volume: current window vs the equal
  // window before it. null when there's no previous data (never a fake +12%).
  momChangePct: number | null;
  // Real per-day volume across the window, zero-filled, UTC-day buckets.
  dailyCounts: { date: string; emails: number }[];
  // Replies actually sent, counted by DISTINCT thread (reviewedAt is stamped
  // per-thread, so counting rows would multiply one reply by the thread size).
  replies: { threads: number };
  // The subset with a supervisor verdict, and how many hit the 'red' (escalate
  // to human) band — the honest denominator for the escalation rate.
  aiReviewed: { count: number; escalated: number };
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
