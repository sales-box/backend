import { z } from 'zod';

export const ClaimSchema = z.object({
  text: z
    .string()
    .describe('The specific factual claim made about the product'),
  status: z
    .enum(['verified', 'flagged', 'hallucinated'])
    .describe(
      'verified = found in cited chunks | flagged = mentioned but not confirmed in chunks | hallucinated = invented, not in any source',
    ),
  source: z.string().optional().describe('Chunk ID that verifies this claim'),
  note: z
    .string()
    .optional()
    .describe('Explanation for flagged or hallucinated claims'),
});

export const ComposerSchema = z.object({
  draftText: z.string().describe('The full email reply text'),
  claims: z
    .array(ClaimSchema)
    .describe(
      'Every factual statement about the recommended product, each with a verification status',
    ),
});

export type ClaimOutput = z.infer<typeof ClaimSchema>;
export type ComposerOutput = z.infer<typeof ComposerSchema>;
