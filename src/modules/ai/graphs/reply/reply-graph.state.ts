import { Annotation } from '@langchain/langgraph';
import { ComposerOutput } from './nodes/composer/composer.schema';
import { ExtractorOutput } from './nodes/extractor/extractor.schema';

export const ReplyGraphState = Annotation.Root({
  emailId: Annotation<string>(),
  tenantId: Annotation<string>(),
  emailBody: Annotation<string>(),
  intent: Annotation<string | undefined>(),
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
