import { Annotation } from '@langchain/langgraph';
import { ComposerOutput } from './nodes/composer/composer.schema';
import { MatchResult } from './nodes/matcher/matcher.schema';
import { ExtractorOutput } from './nodes/extractor/extractor.schema';

export const ReplyGraphState = Annotation.Root({
  emailId: Annotation<string>(),
  tenantId: Annotation<string>(),
  emailBody: Annotation<string>(),
  // Classifier's verdict, from a GeneralAnalysis DB row (a plain string).
  // routeByIntent narrows it; an unknown/missing value → recommendation path.
  intent: Annotation<string | undefined>(),
  // Explicit itemized needs. Optional override — when absent, the matcher
  // derives needs from extractorResult, then falls back to the email body.
  requirements: Annotation<string[] | undefined>(),
  // Written by the matcher node, read by the composer.
  matchResult: Annotation<MatchResult | undefined>(),
  composerResult: Annotation<ComposerOutput | undefined>(),
  finalDraft: Annotation<string | undefined>(),
  excludedByUser: Annotation<string[]>(),
  attachmentsText: Annotation<string[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  externalContentText: Annotation<string[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  extractorResult: Annotation<ExtractorOutput | undefined>(),
});

export type ReplyGraphStateType = typeof ReplyGraphState.State;
