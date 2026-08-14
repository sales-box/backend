import { z } from 'zod';

// This is what YOU produce, not an LLM — that's why "reasoning" isn't
// needed here the way it was in ExtractorSchema. There's no model to
// justify itself; the justification IS the code you're about to write.
export const SupervisorOutputSchema = z.object({
  productConfidence: z.number().min(0).max(1),
  clientHistoryConfidence: z.number().min(0).max(1),
  label: z.enum(['auto_worthy', 'needs_review', 'handle_manually']),
  // Why the label came out the way it did. Without it the panel can only say
  // "handle manually" next to a 98% confidence badge, which reads as a bug.
  labelReason: z.enum([
    'pipeline_error',
    'hallucination',
    'sensitive_intent',
    'urgent',
    'thin_history',
    'confidence',
  ]),
  hallucinationDetected: z.boolean(),
  flaggedClaimsCount: z.number().int().min(0),
  draftAvailable: z.boolean(),
  knowledgeGapSuggestion: z.string().nullable(),
});

export type SupervisorOutput = z.infer<typeof SupervisorOutputSchema>;

// The 4 inputs, gathered from 3 different places:
//   classifierOutput  — GeneralAnalysis row (DB, read before graph.invoke)
//   extractorOutput   — graph final state (PR1)
//   matcherOutput     — graph final state (Karim, mock until his PR lands)
//   composerOutput    — graph final state (Abd-elrahman, from composer.schema.ts)
export interface SupervisorInput {
  classifierOutput: {
    intent: string;
    intentConfidence: number;
    isUrgent: boolean;
  };
  extractorOutput: {
    featuresInferred: boolean;
    constraintsInferred: boolean;
    scaleInferred: boolean;
    budgetInferred: boolean;
    timelineInferred: boolean;
  };
  matcherOutput: {
    matchConfidence: number;
  };
  composerOutput: {
    draftText: string;
    claims: Array<{ status: 'verified' | 'flagged' | 'hallucinated' }>;
  };
  // TOTAL logged interactions for this client — ClientContext.historyCount, NOT
  // history.length. The history array is truncated to the 5 most recent for
  // display, which made 5, 20 and 200 interactions indistinguishable here.
  clientHistoryLength: number;
  isNewClient: boolean;
  /**
   * The draft graph threw, so there is no composer output at all.
   *
   * This used to be signalled by injecting a fake `{ status: 'hallucinated' }`
   * claim, which worked while the label was the only thing anyone saw. Now that
   * the reason is rendered in the panel, that lie surfaces as "a claim in the
   * draft contradicts the knowledge base" on an email that has no draft.
   */
  pipelineFailed?: boolean;
}
