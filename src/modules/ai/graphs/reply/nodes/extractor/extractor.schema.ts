import { z } from 'zod';

export const ExtractorSchema = z.object({
  reasoning: z
    .string()
    .describe(
      '1-3 short sentences justifying every inferred field. Fill this first.',
    ),

  features: z
    .array(z.string())
    .describe(
      'Product/capability keywords explicitly requested or clearly implied',
    ),
  featuresInferred: z.boolean(),

  constraints: z
    .string()
    .nullable()
    .describe(
      'Any stated limitation (budget cap, timeline, tech stack requirement)',
    ),
  constraintsInferred: z.boolean(),

  scale: z
    .string()
    .nullable()
    .describe(
      'Company size / deployment scale, e.g. "large enterprise (~500 employees)"',
    ),
  scaleInferred: z.boolean(),
  scaleInferenceSource: z
    .string()
    .nullable()
    .describe(
      'The concrete signal in the email that grounds the inference, or null',
    ),

  budgetHint: z
    .string()
    .nullable()
    .describe(
      'NEVER invent a number. Null unless the email states or clearly implies a budget range',
    ),
  budgetInferred: z.boolean(),

  timeline: z
    .string()
    .nullable()
    .describe('Urgency/deadline signal from the email'),
  timelineInferred: z.boolean(),
});

export type ExtractorOutput = z.infer<typeof ExtractorSchema>;
