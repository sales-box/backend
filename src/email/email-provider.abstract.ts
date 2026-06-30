import { ParsedMessage } from '@/email/email.types';

export abstract class EmailProvider {
  abstract getMessage(
    messageId: string,
    emailAccountId: string,
  ): Promise<ParsedMessage>;
}
