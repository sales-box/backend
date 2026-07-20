export interface EmailRowData {
  threadId: string;
  clientName: string;
  company: string;
  subjectSnippet: string;
  timestamp: string;
  status?: 'ready' | 'needs-review' | 'manual';
}
