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

   fetchThreads(emailAccount: string) {
    /**
     * Suggested refactoring steps:
     * 1. create a generic type (ex. EmailThread) in email.types.ts to represent the structure of an email thread.
     * 2. use GmailClientFactory to create authenticated client for the given emailAccount.
     * 3. delegate any response parsing steps to GmailParserService.
     * 4. return the parsed threads as an array of EmailThread objects.
     */
  }
}
