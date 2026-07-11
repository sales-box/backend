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

  getContactByEmail(email: string): Promise<{ id: string } | null> {
    if (email.startsWith('nonexistent') || email.includes('notfound')) {
      return Promise.resolve(null);
    }
    const safeEmail = email.replace('@', '-');
    return Promise.resolve({ id: `mock-contact-${safeEmail}` });
  }

  fetchContacts(): Promise<
    Array<{
      email: string;
      name?: string;
      company?: string;
      crmId: string;
    }>
  > {
    return Promise.resolve([
      {
        email: 'crm-user-1@acme.com',
        name: 'Alice Smith',
        company: 'Acme',
        crmId: 'mock-contact-crm-1',
      },
      {
        email: 'crm-user-2@test.com',
        name: 'Bob Jones',
        company: 'TestCorp',
        crmId: 'mock-contact-crm-2',
      },
    ]);
  }
}
