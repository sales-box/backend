import type { ClientStatus } from '../clients/client-status';

/**
 * What the connect flow needs from a CRM, and nothing more.
 *
 * This used to carry syncContact / createOrUpdateDeal / logEngagementNote — a
 * queue-driven write path that no caller ever reached. Writes now go through
 * the actions agent, which the SE approves per action, so the adapters exist
 * only to prove a credential works and to import the contact list once.
 */
export interface CrmContact {
  email: string;
  name?: string;
  company?: string;
  crmId: string;
  /**
   * Where the CRM says this contact sits in its lifecycle, normalised to our
   * own vocabulary. Undefined when the CRM has no opinion or uses a stage we
   * do not recognise — the caller then leaves the existing status alone.
   */
  status?: ClientStatus;
}

export interface ICrmAdapter {
  /** Look a contact up by email. Used to confirm a credential can read. */
  getContactByEmail(email: string): Promise<{ id: string } | null>;

  /**
   * The tenant's contacts, imported once at connect time. Doubles as the
   * credential check: if this throws, the connection is not established.
   */
  fetchContacts(): Promise<CrmContact[]>;
}
