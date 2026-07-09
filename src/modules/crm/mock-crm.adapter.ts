import { Injectable, Logger } from '@nestjs/common';
import { ClientRecord } from '../clients/clients.interface';
import type { ICrmAdapter, NotePayload } from './crm.interface';

@Injectable()
export class MockCrmAdapter implements ICrmAdapter {
  private readonly logger = new Logger(MockCrmAdapter.name);

  syncContact(client: ClientRecord): Promise<string> {
    const contactId = `mock-contact-${client.id}`;
    this.logger.log(`[mock] syncContact(${client.email}) -> ${contactId}`);
    return Promise.resolve(contactId);
  }

  createOrUpdateDeal(
    contactId: string,
    classification: string,
    subject: string,
    company: string,
  ): Promise<string> {
    const dealId = `mock-deal-${contactId}`;
    this.logger.log(
      `[mock] createOrUpdateDeal(${contactId}, ${classification}, "${subject}", "${company}") -> ${dealId}`,
    );
    return Promise.resolve(dealId);
  }

  logEngagementNote(contactId: string, note: NotePayload): Promise<void> {
    this.logger.log(
      `[mock] logEngagementNote(${contactId}): ${note.subject} [${note.classification}]`,
    );
    return Promise.resolve();
  }
}
