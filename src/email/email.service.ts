import { Injectable } from '@nestjs/common';
import { EmailProvider } from '@/email/email-provider.abstract';
import { ParsedMessage } from '@/email/email.types';

@Injectable()
export class EmailService {
  constructor(private readonly emailProvider: EmailProvider) {}

  async fetchMessage(
    messageId: string,
    emailAccount: string,
  ): Promise<ParsedMessage> {
    return this.emailProvider.fetchMessage(messageId, emailAccount);
  }
}
