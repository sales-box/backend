export interface ClientRecord {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}
