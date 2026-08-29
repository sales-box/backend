import { type ClientStatus, isClientStatus } from '../clients/client-status';
import type { CrmContact } from './crm.interface';

/**
 * Turning a Zoho MCP answer into contacts.
 *
 * Kept apart from the adapter because the shape is the uncertain part. An MCP
 * tool may hand back a JSON string, a `{content:[{type:'text',text}]}` block,
 * the Zoho envelope `{data:[...]}`, or a bare array — and Zoho's own field
 * names differ between Leads and Contacts. Every one of those is parsed here
 * and covered by tests, so the adapter stays a thin caller.
 */

/** Zoho record fields we read. Everything else on the record is ignored. */
interface ZohoRecord {
  id?: unknown;
  Email?: unknown;
  First_Name?: unknown;
  Last_Name?: unknown;
  Full_Name?: unknown;
  Company?: unknown;
  Account_Name?: unknown;
  Lead_Status?: unknown;
  [key: string]: unknown;
}

const str = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
};

/**
 * Zoho's stock Lead_Status values, mapped onto our ladder.
 *
 * The negative outcomes map to nothing rather than to `new_inquiry`: a junk or
 * lost lead is not a fresh enquiry, and we have no status that says so. They
 * keep whatever the row already had.
 *
 * Zoho Contacts carry no lifecycle field at all, so a contact with no
 * Lead_Status yields undefined and the caller applies the default.
 */
const LEAD_STATUS_TO_CLIENT_STATUS: Readonly<Record<string, ClientStatus>> = {
  'not contacted': 'new_inquiry',
  'attempted to contact': 'new_inquiry',
  'contact in future': 'new_inquiry',
  contacted: 'new_inquiry',
  'pre-qualified': 'qualified',
  'pre qualified': 'qualified',
  qualified: 'qualified',
};

export function statusFromLeadStatus(
  leadStatus?: unknown,
): ClientStatus | undefined {
  const key = str(leadStatus)?.toLowerCase();
  if (!key) return undefined;
  const mapped = LEAD_STATUS_TO_CLIENT_STATUS[key];
  // The guard also blocks Object.prototype keys, which the lookup would
  // otherwise resolve to a function.
  return isClientStatus(mapped) ? mapped : undefined;
}

/** `Account_Name` is `{name}` on a Contact and a plain string on a Lead. */
function companyOf(record: ZohoRecord): string | undefined {
  const account = record.Account_Name;
  if (account && typeof account === 'object') {
    return str((account as { name?: unknown }).name);
  }
  return str(account) ?? str(record.Company);
}

function nameOf(record: ZohoRecord): string | undefined {
  const full = str(record.Full_Name);
  if (full) return full;
  const parts = [str(record.First_Name), str(record.Last_Name)].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Dig the record array out of whatever the MCP tool returned.
 *
 * Returns an empty array rather than throwing on an unrecognised shape: a
 * connect that imports nothing is recoverable, one that 500s is not.
 */
export function extractRecords(payload: unknown): ZohoRecord[] {
  if (payload == null) return [];

  if (typeof payload === 'string') {
    try {
      return extractRecords(JSON.parse(payload));
    } catch {
      return [];
    }
  }

  if (Array.isArray(payload)) {
    // An MCP content block array: [{type:'text', text:'{...}'}]
    const textBlocks = payload
      .filter(
        (p): p is { text: string } =>
          !!p &&
          typeof p === 'object' &&
          typeof (p as { text?: unknown }).text === 'string',
      )
      .map((p) => p.text);
    if (textBlocks.length > 0) {
      return textBlocks.flatMap((t) => extractRecords(t));
    }
    return payload.filter((p): p is ZohoRecord => !!p && typeof p === 'object');
  }

  if (typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    // Try each wrapper in turn and keep the first that actually yields records.
    //
    // Returning on the first key that merely EXISTS was wrong twice over: a key
    // present but null or empty ended the search early, and Zoho's real answer
    // is a single MCP content object — { type, text, structuredContent } —
    // whose records sit one level further in. Verified against a live server on
    // 29 Aug: `text` is a JSON string of { data, info }, and structuredContent
    // is { data, status }.
    for (const key of [
      'data',
      'records',
      'structuredContent',
      'text',
      'content',
      'result',
      'results',
    ]) {
      if (!(key in o) || o[key] == null) continue;
      const found = extractRecords(o[key]);
      if (found.length > 0) return found;
    }
  }

  return [];
}

/**
 * Map Zoho records onto CrmContacts, dropping anything without an email.
 *
 * A record with no email cannot be matched to an inbound sender, which is the
 * only thing the local client row is for.
 */
/** The two modules a person can live in. */
export type ZohoModule = 'Contacts' | 'Leads';

/**
 * What the module itself says about a person.
 *
 * Zoho carries `Lead_Status` on Leads and nothing equivalent on Contacts, so
 * reading only that field made the import say the opposite of the truth: a
 * qualified Contact — someone converted out of a lead and attached to a real
 * Account — landed on `new_inquiry`, the lowest rung, while an unqualified Lead
 * could land on `qualified`.
 *
 * Being in the Contacts module IS the lifecycle signal. It means qualified and
 * account-attached. It does not mean `customer`: that would need a won deal,
 * and the import does not read Deals.
 *
 * A Lead yields undefined when its status is unrecognised, so the caller's own
 * default applies and an existing row is left alone.
 */
const MODULE_STATUS: Readonly<Record<ZohoModule, ClientStatus | undefined>> = {
  Contacts: 'qualified',
  Leads: undefined,
};

export function toCrmContacts(
  records: ZohoRecord[],
  module: ZohoModule,
): CrmContact[] {
  return records.flatMap((record) => {
    const email = str(record.Email);
    const crmId = str(record.id);
    if (!email || !crmId) return [];
    return [
      {
        email,
        name: nameOf(record),
        company: companyOf(record),
        crmId,
        // An explicit Lead_Status always wins over the module's default.
        status:
          statusFromLeadStatus(record.Lead_Status) ?? MODULE_STATUS[module],
      },
    ];
  });
}
