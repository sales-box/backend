export interface ClientRecord {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  status: string;
  crmId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClientContext {
  isNewClient: boolean;
  /** How the client record was resolved. 'crm' and 'individual' mean this
   *  exact person is known. 'domain' means only someone else at the same
   *  company is known — history below belongs to THAT person, not this one. */
  matchedBy: 'crm' | 'domain' | 'individual' | null;
  clientId: string | null;
  status: string;
  name: string;
  company: string;
  crmId: string | null;
  history: {
    date: string;
    type: string;
    subject: string;
    summary: string | null;
    classification: string | null;
    recommendation: string | null;
  }[];
}
