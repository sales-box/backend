import { z } from 'zod';

export const ExclusionSchema = z.object({
  product: z.string().describe('Name of the product that was considered'),
  reason: z
    .string()
    .describe(
      'Why it was rejected — a missing requirement, a mismatch, or the user explicitly excluded it in a previous attempt',
    ),
});

/**
 * What the LLM fills in. Deliberately does NOT include
 * basedOnLowConfidenceSource — that flag is a fact the retrieval query
 * already returns deterministically (documents.is_low_confidence), so the
 * node sets it in code. Never ask the model a question the database has
 * already answered.
 */
export const MatcherSchema = z.object({
  resultType: z
    .enum(['recommendation', 'answer'])
    .describe(
      'recommendation = the email asks what to buy and WE picked a product for their requirements | answer = the email asks a technical/support question and we answered it from the documents without choosing a product',
    ),
  recommendedProduct: z
    .string()
    .nullable()
    .describe(
      'Product name ONLY when resultType is recommendation. MUST be null when resultType is answer — even if the client named a product themselves, we did not choose it, so nothing goes here',
    ),
  reasoning: z
    .string()
    .describe(
      'Short explanation of the decision, grounded strictly in the cited chunks — no outside knowledge',
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'For recommendation: how well the product fits the stated requirements (1 = every requirement confirmed by the chunks). For answer: whether the chunks actually contain the answer (1 = answered directly, low = improvising from loosely related chunks). Do not blend the two meanings',
    ),
  citedChunks: z
    .array(z.string())
    .describe(
      'IDs of the chunks this result is based on. Only IDs from the provided chunks — never invent one',
    ),
  exclusions: z
    .array(ExclusionSchema)
    .describe(
      'Products considered but rejected, each with its reason. Empty array if none were considered',
    ),
});

export type MatcherOutput = z.infer<typeof MatcherSchema>;
export type ExclusionOutput = z.infer<typeof ExclusionSchema>;

/**
 * What the matcher node returns into graph state: the LLM's output plus
 * the code-computed source-quality flag (true if any cited chunk belongs
 * to a document flagged by the knowledge-base quality gate).
 */
export type MatchResult = MatcherOutput & {
  basedOnLowConfidenceSource: boolean;
};
