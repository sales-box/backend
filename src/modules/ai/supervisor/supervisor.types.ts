import { z } from 'zod';

// This is what YOU produce, not an LLM — that's why "reasoning" isn't
// needed here the way it was in ExtractorSchema. There's no model to
// justify itself; the justification IS the code you're about to write.
export const SupervisorOutputSchema = z.object({
  productConfidence: z.number().min(0).max(1),
  clientHistoryConfidence: z.number().min(0).max(1),
  label: z.enum(['auto_worthy', 'needs_review', 'handle_manually']),
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
  clientHistoryLength: number; // ClientContext.history.length, from getClientContext (Nagy)
  isNewClient: boolean;
}
