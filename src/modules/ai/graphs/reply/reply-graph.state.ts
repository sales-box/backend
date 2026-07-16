import { Annotation } from '@langchain/langgraph';
import { ComposerOutput } from './nodes/composer/composer.schema';
import { MatchResult } from './nodes/matcher/matcher.schema';
import { Intent } from '@/modules/ai/classifier/classifier.types';

export const ReplyGraphState = Annotation.Root({
  emailId: Annotation<string>(),
  tenantId: Annotation<string>(),
  emailBody: Annotation<string>(),
  // Classifier's verdict for this email. Optional until the caller contract
  // lands (S-AI-7): the matcher falls back to the recommendation path.
  intent: Annotation<Intent | undefined>(),
  // Itemized needs extracted from the email, e.g. ["outdoor use", "230V"].
  // A list, not a blob: joining for embedding is trivial, splitting isn't.
  requirements: Annotation<string[] | undefined>(),
  // Written by the matcher node, read by the composer.
  matchResult: Annotation<MatchResult | undefined>(),
  composerResult: Annotation<ComposerOutput | undefined>(),
  finalDraft: Annotation<string | undefined>(),
  excludedByUser: Annotation<string[]>(),
});

export type ReplyGraphStateType = typeof ReplyGraphState.State;
