import { ParsedMessage } from '@/modules/email/email.types';

export abstract class EmailProvider {
  abstract fetchMessage(
    messageId: string,
    emailAccount: string,
  ): Promise<ParsedMessage>;

  abstract fetchThreads(
    emailAccount: string,
  )
}
