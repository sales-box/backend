import { Injectable } from '@nestjs/common';
import { EmailProvider } from '@/modules/email/email-provider.abstract';
import { EmailThread, ParsedMessage } from '@/modules/email/email.types';

@Injectable()
export class EmailService {
  constructor(private readonly emailProvider: EmailProvider) {}

  async fetchMessage(
    tenantId: string,
    messageId: string,
    emailAccount: string,
  ): Promise<ParsedMessage> {
    return this.emailProvider.fetchMessage(tenantId, messageId, emailAccount);
  }

  async fetchThreads(
    tenantId: string,
    emailAccount: string,
    query?: string,
  ): Promise<EmailThread[]> {
    return this.emailProvider.fetchThreads(tenantId, emailAccount, query);
  }
}
