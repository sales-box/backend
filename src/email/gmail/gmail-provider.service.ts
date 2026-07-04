import { Injectable } from '@nestjs/common';
import { EmailProvider } from '@/email/email-provider.abstract';
import { ParsedMessage } from '@/email/email.types';
import { GmailParserService } from '@/email/gmail/gmail-parser.service';
import { GmailClientFactory } from '@/email/gmail/gmail-client.factory';

@Injectable()
export class GmailProvider implements EmailProvider {
  constructor(
    private readonly clientFactory: GmailClientFactory,
    private readonly parser: GmailParserService,
  ) {}

  async fetchMessage(
    messageId: string,
    emailAccount: string,
  ): Promise<ParsedMessage> {
    const gmailClient = await this.clientFactory.createClient(emailAccount);

    const message = await gmailClient.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    return this.parser.parseMessage(message.data);
  }
}
