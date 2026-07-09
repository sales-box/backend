import { Injectable, Logger } from '@nestjs/common';
import { ClientRecord } from '../clients/clients.interface';
import { ICrmAdapter } from './crm.interface';

@Injectable()
export class MockCrmAdapter implements ICrmAdapter {
  private readonly logger = new Logger(MockCrmAdapter.name);

  syncContact(client: ClientRecord): Promise<string> {
    const contactId = `mock-contact-${client.id}`;
    this.logger.log(`[mock] syncContact(${client.email}) -> ${contactId}`);
    return Promise.resolve(contactId);
  }

  logNote(contactId: string, note: string): Promise<void> {
    this.logger.log(`[mock] logNote(${contactId}): ${note}`);
    return Promise.resolve();
  }
}
