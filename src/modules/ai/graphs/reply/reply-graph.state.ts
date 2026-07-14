import { Annotation } from '@langchain/langgraph';
import { ComposerOutput } from './nodes/composer/composer.schema';

export const ReplyGraphState = Annotation.Root({
  emailId: Annotation<string>(),
  tenantId: Annotation<string>(),
  emailBody: Annotation<string>(),
  composerResult: Annotation<ComposerOutput | undefined>(),
  finalDraft: Annotation<string | undefined>(),
  excludedByUser: Annotation<string[]>(),
});

export type ReplyGraphStateType = typeof ReplyGraphState.State;
