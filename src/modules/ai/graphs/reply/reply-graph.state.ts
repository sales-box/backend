import { StateSchema } from '@langchain/langgraph';
import { ComposerSchema } from './nodes/composer/composer.schema';
import { ExtractorSchema } from './nodes/extractor/extractor.schema';
import { MatchResult } from './nodes/matcher/matcher.schema';
import { z } from 'zod';

export const ReplyGraphState = new StateSchema({
  tenantId: z.string(),
  connectedAccountId: z.string(),
  threadId: z.string(),
  messageId: z.string(),

  // Context & inputs
  emailBody: z.string(),
  intent: z.string().optional(),
  requirements: z.array(z.string()).optional(),
  attachmentsText: z.array(z.string()).default([]),
  externalContentText: z.array(z.string()).default([]),
  clientHistory: z
    .array(
      z.object({
        date: z.string(),
        type: z.string(),
        subject: z.string(),
        summary: z.string().nullable(),
        classification: z.string().nullable(),
        recommendation: z.string().nullable(),
      }),
    )
    .default([]),

  matchResult: z.custom<MatchResult>().optional(),
  composerResult: ComposerSchema.optional(),
  extractorResult: ExtractorSchema.optional(),

  finalDraft: z.string().optional(),
  memoryUpdated: z.boolean().optional(),
  excludedByUser: z.array(z.string()).default([]),
});

export type ReplyGraphStateType = typeof ReplyGraphState.State;
