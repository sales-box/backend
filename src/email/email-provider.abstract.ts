import { ParsedMessage } from '@/email/email.types';

export abstract class EmailProvider {
  abstract fetchMessage(
    messageId: string,
    emailAccount: string,
  ): Promise<ParsedMessage>;
}
