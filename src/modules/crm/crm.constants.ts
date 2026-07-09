export const CRM_QUEUE = 'crm-sync';

export const SYNC_CONTACT_JOB = 'sync-contact';
export const CREATE_DEAL_JOB = 'create-deal';
export const LOG_NOTE_JOB = 'log-note';

export const CRM_ADAPTER = Symbol('CRM_ADAPTER');

export enum CrmProvider {
  HubSpot = 'hubspot',
  Mock = 'mock',
}
