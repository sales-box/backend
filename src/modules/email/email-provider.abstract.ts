import { EmailThread, ParsedMessage } from '@/modules/email/email.types';

/**
 * A mailbox provider. Every method takes `tenantId` first: the credentials
 * behind these calls are resolved by a tenant-scoped lookup, and the email
 * address alone is not an authorization decision — callers often take it from
 * a request body.
 */
export abstract class EmailProvider {
  abstract fetchMessage(
    tenantId: string,
    messageId: string,
    emailAccount: string,
  ): Promise<ParsedMessage>;

  abstract fetchThreads(
    tenantId: string,
    emailAccount: string,
    query?: string,
  ): Promise<EmailThread[]>;
}
