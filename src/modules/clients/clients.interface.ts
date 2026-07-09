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
  clientId: string | null;
  status: string;
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
