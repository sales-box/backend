import { Injectable } from '@nestjs/common';
import { EmailProvider } from '@/modules/email/email-provider.abstract';
import { ParsedMessage } from '@/modules/email/email.types';
import { GmailParserService } from '@/modules/email/gmail/gmail-parser.service';
import { GmailClientFactory } from '@/modules/email/gmail/gmail-client.factory';

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
