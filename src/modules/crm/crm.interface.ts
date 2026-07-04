import { ClientRecord } from '../clients/clients.interface';
export interface ICrmAdapter {
  syncContact(client: ClientRecord): Promise<string>;

  logNote(contactId: string, note: string): Promise<void>;
}
