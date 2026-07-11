import { ClientRecord } from '../clients/clients.interface';

export interface NotePayload {
  subject: string;
  summary: string;
  classification: string;
  sentAt: string;
}

export interface ICrmAdapter {
  syncContact(client: ClientRecord): Promise<string>;

  createOrUpdateDeal(
    contactId: string,
    classification: string,
    subject: string,
    company: string,
  ): Promise<string>;

  logEngagementNote(contactId: string, note: NotePayload): Promise<void>;

  getContactByEmail(email: string): Promise<{ id: string } | null>;

  fetchContacts(): Promise<
    Array<{
      email: string;
      name?: string;
      company?: string;
      crmId: string;
    }>
  >;
}
