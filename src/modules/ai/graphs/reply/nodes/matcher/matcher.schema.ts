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
 * Two flat schemas instead of one nullable one — code routes by intent and
 * hands the model the right form. The answer form has NO product field at
 * all, so "answered a question but pitched a product anyway" is impossible
 * by construction, not by a guard. Flat (not a discriminated union) because
 * branched anyOf schemas are where mid-size models fill forms unreliably.
 */
export const RecommendationSchema = z.object({
  recommendedProduct: z
    .string()
    .describe(
      'Exact product name as written in the provided chunks — never invented',
    ),
  reasoning: z
    .string()
    .describe(
      'Short explanation of why this product fits, grounded strictly in the cited chunks — no outside knowledge',
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'How well the product fits the stated requirements (1 = every requirement confirmed by the chunks). Lower it when requirements are unconfirmed',
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

export const AnswerSchema = z.object({
  reasoning: z
    .string()
    .describe(
      "The answer to the client's question, grounded strictly in the cited chunks — or a plain statement that the documents do not contain the answer",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'Whether the chunks actually contain the answer (1 = answered directly, low = improvising from loosely related chunks)',
    ),
  citedChunks: z
    .array(z.string())
    .describe(
      'IDs of the chunks this answer is based on. Only IDs from the provided chunks — never invent one',
    ),
});

export type RecommendationOutput = z.infer<typeof RecommendationSchema>;
export type AnswerOutput = z.infer<typeof AnswerSchema>;
export type ExclusionOutput = z.infer<typeof ExclusionSchema>;

/**
 * What the matcher node returns into graph state: the LLM's output merged
 * with code-computed fields. resultType and recommendedProduct-nullability
 * are set by CODE (routed by intent), never declared by the model.
 */
export type MatchResult = {
  resultType: 'recommendation' | 'answer';
  recommendedProduct: string | null;
  reasoning: string;
  confidence: number;
  citedChunks: string[];
  exclusions: ExclusionOutput[];
  /** True if any cited chunk belongs to a document flagged by the
   *  knowledge-base quality gate. From the DB, never from the model. */
  basedOnLowConfidenceSource: boolean;
  /** Full text of the cited chunks — the composer's claim verification
   *  needs the words, not just the IDs. */
  citedChunkDetails: { id: string; content: string }[];
};
