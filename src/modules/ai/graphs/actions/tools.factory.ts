import { tool, StructuredTool } from 'langchain';
import { z } from 'zod';
import { cleanPhone } from './phone';
import { extractRecords } from '../../../crm/zoho-records';

interface McpTools {
  searchRecords: StructuredTool;
  createRecords: StructuredTool;
  updateRecords: StructuredTool;
}

/**
 * Drop the prose the model appends to a phone number.
 *
 * Zoho validates per RECORD, not per field, so one malformed Phone throws away
 * the company and job title sent alongside it — and the failure reaches the
 * panel as a success. Seen live on 29 Aug.
 */
function withCleanPhone<T extends { Phone?: string }>(fields: T): T {
  if (!('Phone' in fields)) return fields;
  const Phone = cleanPhone(fields.Phone);
  const next = { ...fields, Phone };
  if (Phone === undefined) delete next.Phone;
  return next;
}

export function buildTools(mcp: McpTools): {
  readTools: StructuredTool[];
  writeTools: StructuredTool[];
} {
  const SUMMARY = z
    .string()
    .describe(
      'One concise, plain-language sentence describing this action for a non-technical reviewer. ' +
        'No field names, API names, or record IDs.',
    );

  /**
   * A bare empty array does not read as an answer.
   *
   * The HubSpot tools carry a `{ found, ... }` envelope because a raw empty
   * result made the model re-issue the same search until the graph hit its
   * recursion limit — 18 identical searches, dead after 76 seconds, and the
   * panel showed "No suggested actions" as though that were a verdict. Zoho
   * returned the raw MCP payload and was never given the fix.
   */
  const searchModule = async (module: string, email: string) => {
    const raw: unknown = await mcp.searchRecords.invoke({
      path_variables: { module },
      query_params: { email },
    });

    // Counting the raw payload was wrong: Zoho answers with a single MCP
    // content object, which is always truthy, so `found` was 1 even for an
    // empty result. The model then believed a record existed, and — having no
    // id to work with — INVENTED one ("1234567890123456789") and passed it to
    // updateContact, createTask and createDeal. Approving that would have
    // written someone else's record or failed outright.
    const records = extractRecords(raw);
    return {
      found: records.length,
      // Only the fields an action needs. The raw Zoho record carries ~90
      // properties, and burying the id in them is what made it guessable.
      records: records.map((r) => ({
        id: r.id,
        Full_Name: r.Full_Name,
        Email: r.Email,
        Company: r.Company ?? r.Account_Name,
      })),
    };
  };

  const SEARCH_DESCRIPTION =
    'found: 0 is a conclusive answer — the record does not exist. Do not repeat ' +
    'the search; create the record instead. Every id you pass to another tool ' +
    'must come from a records[] entry here — never invent or guess an id.';

  const searchLeads = tool(
    async ({ email }): Promise<unknown> => searchModule('Leads', email),
    {
      name: 'searchLeads',
      description: `Search Zoho CRM Leads by sender email. ${SEARCH_DESCRIPTION}`,
      schema: z.object({
        email: z.string().describe("The sender's email address to search for"),
      }),
    },
  );

  const searchContacts = tool(
    async ({ email }): Promise<unknown> => searchModule('Contacts', email),
    {
      name: 'searchContacts',
      description: `Search Zoho CRM Contacts by sender email. ${SEARCH_DESCRIPTION}`,
      schema: z.object({
        email: z.string().describe("The sender's email address to search for"),
      }),
    },
  );

  const createLead = tool(
    async ({ summary: _summary, ...fields }): Promise<unknown> =>
      mcp.createRecords.invoke({
        path_variables: { module: 'Leads' },
        body: { data: [withCleanPhone(fields)] },
      }),
    {
      name: 'createLead',
      description:
        'Create a new Lead record in Zoho CRM. Use for email senders not found in Contacts or Leads.',
      schema: z.object({
        Last_Name: z.string().describe("Lead's last name — required by Zoho"),
        First_Name: z.string().optional().describe("Lead's first name"),
        Email: z.string().describe("Lead's email address"),
        Company: z.string().describe("Lead's company name — required by Zoho"),
        Designation: z.string().optional().describe("Lead's job title"),
        Phone: z.string().optional(),
        Description: z.string().optional().describe('Context from the email'),
        Lead_Status: z
          .enum(['New', 'Contacted', 'Not Contacted'])
          .optional()
          .default('New'),
        summary: SUMMARY,
      }),
    },
  );

  const updateLead = tool(
    async ({ summary: _summary, ...fields }): Promise<unknown> =>
      mcp.updateRecords.invoke({
        path_variables: { module: 'Leads' },
        body: { data: [withCleanPhone(fields)] },
      }),
    {
      name: 'updateLead',
      description:
        'Update an existing Lead record after receiving an email: correct the ' +
        'company, job title, phone or name the sender gave, change the status, ' +
        'or add context. Only pass fields the email actually states.',
      // These mirror createLead's schema. They were missing, so an approved
      // "update the company name and job title" wrote nothing at all — the tool
      // had no parameter to carry either, and the silent no-op was reported as
      // success. Seen live on 29 Aug: a lead stayed "Company: Unknown" after an
      // email that named the company in its signature.
      schema: z.object({
        id: z.string().describe('Zoho Lead record ID from searchLeads result'),
        Company: z
          .string()
          .optional()
          .describe("The lead's company, when the email states it"),
        Designation: z
          .string()
          .optional()
          .describe("The lead's job title, when the email states it"),
        Phone: z.string().optional(),
        First_Name: z.string().optional(),
        Last_Name: z
          .string()
          .optional()
          .describe('Only when the email gives a fuller or corrected name'),
        Lead_Status: z
          .enum([
            'New',
            'Contacted',
            'Not Contacted',
            'Junk Lead',
            'Lost Lead',
            'Not Qualified',
            'Pre-Qualified',
            'Qualified',
          ])
          .optional(),
        Description: z
          .string()
          .optional()
          .describe('Updated notes from the email context'),
        summary: SUMMARY,
      }),
    },
  );

  const updateContact = tool(
    async ({ summary: _summary, ...fields }): Promise<unknown> =>
      mcp.updateRecords.invoke({
        path_variables: { module: 'Contacts' },
        body: { data: [withCleanPhone(fields)] },
      }),
    {
      name: 'updateContact',
      description:
        'Update an existing Contact record after receiving an email: correct the ' +
        'job title, phone or name the sender gave, or add context. Only pass ' +
        'fields the email actually states.',
      // Description alone was not enough — the HubSpot equivalent writes six
      // properties, so an approved "they changed role" wrote nothing on Zoho.
      // Account_Name is deliberately absent: on a Contact that is a lookup to
      // an Account record, and moving someone between companies is not
      // something to infer from an email signature.
      schema: z.object({
        id: z
          .string()
          .describe('Zoho Contact record ID from searchContacts result'),
        Title: z
          .string()
          .optional()
          .describe("The contact's job title, when the email states it"),
        Phone: z.string().optional(),
        First_Name: z.string().optional(),
        Last_Name: z
          .string()
          .optional()
          .describe('Only when the email gives a fuller or corrected name'),
        Description: z
          .string()
          .optional()
          .describe('Updated notes from the email context'),
        summary: SUMMARY,
      }),
    },
  );

  const createTask = tool(
    async ({ summary: _summary, contact_id, ...fields }): Promise<unknown> => {
      const data: Record<string, unknown> = { ...fields };

      if (contact_id) {
        data.Who_Id = { id: contact_id };
        data.$se_module = 'Contacts';
      }

      return mcp.createRecords.invoke({
        path_variables: { module: 'Tasks' },
        body: { data: [data] },
      });
    },
    {
      name: 'createTask',
      description:
        'Create a follow-up Task in Zoho CRM. ' +
        'Optionally link to a Contact via contact_id. ' +
        'Tasks CANNOT be linked to Leads — if the sender is a Lead or new prospect, ' +
        'omit contact_id and the task will be created unlinked.',
      schema: z.object({
        Subject: z.string().describe('Task subject line'),
        Due_Date: z.string().describe('Due date in YYYY-MM-DD format'),
        Priority: z.enum(['High', 'Medium', 'Low']).optional(),
        Status: z
          .enum([
            'Not Started',
            'In Progress',
            'Completed',
            'Waiting for input',
            'Deferred',
          ])
          .optional()
          .default('Not Started'),
        contact_id: z
          .string()
          .optional()
          .describe(
            'Contact record ID to link this task to. ' +
              'Omit when sender is a Lead or unknown prospect.',
          ),
        summary: SUMMARY,
      }),
    },
  );

  const createNote = tool(
    async ({
      summary: _summary,
      parent_id,
      parent_module,
      Note_Content,
      Note_Title,
    }): Promise<unknown> => {
      const data: Record<string, unknown> = {
        Note_Content,
        Parent_Id: { id: parent_id, module: { api_name: parent_module } },
      };
      if (Note_Title) data.Note_Title = Note_Title;

      return mcp.createRecords.invoke({
        path_variables: { module: 'Notes' },
        body: { data: [data] },
      });
    },
    {
      name: 'createNote',
      description:
        'Attach a contextual Note to an existing CRM record (Lead, Contact, Deal, or Case).',
      schema: z.object({
        Note_Content: z.string().describe('Note body text'),
        Note_Title: z.string().optional().describe('Optional note title'),
        parent_id: z.string().describe('Record ID of the parent record'),
        parent_module: z
          .enum(['Leads', 'Contacts', 'Deals', 'Cases'])
          .describe('Module of the parent record'),
        summary: SUMMARY,
      }),
    },
  );

  const createDeal = tool(
    async ({
      summary: _summary,
      contact_id,
      Amount,
      ...fields
    }): Promise<unknown> => {
      const data: Record<string, unknown> = { ...fields };
      if (contact_id) data.Contact_Name = { id: contact_id };
      if (Amount !== undefined) data.Amount = Amount;

      return mcp.createRecords.invoke({
        path_variables: { module: 'Deals' },
        body: { data: [data] },
      });
    },
    {
      name: 'createDeal',
      description:
        'Create a Deal (revenue opportunity) in Zoho CRM for emails that show financial intent.',
      schema: z.object({
        Deal_Name: z.string().describe('Deal name'),
        Stage: z.enum([
          'Qualification',
          'Needs Analysis',
          'Value Proposition',
          'Id. Decision Makers',
          'Perception Analysis',
          'Proposal/Price Quote',
          'Negotiation/Review',
          'Closed Won',
          'Closed Lost',
        ]),
        Closing_Date: z
          .string()
          .describe('Expected close date in YYYY-MM-DD format'),
        Amount: z
          .number()
          .optional()
          .describe(
            'Deal value. Set ONLY if explicitly stated in the email. Never fabricate a number.',
          ),
        contact_id: z
          .string()
          .optional()
          .describe('Contact record ID to link this deal to'),
        Description: z.string().optional().describe('Context from the email'),
        summary: SUMMARY,
      }),
    },
  );

  const createCase = tool(
    async ({ summary: _summary, contact_id, ...fields }): Promise<unknown> => {
      const data: Record<string, unknown> = { ...fields, Case_Origin: 'Email' };
      if (contact_id) data.Contact_Name = { id: contact_id };

      return mcp.createRecords.invoke({
        path_variables: { module: 'Cases' },
        body: { data: [data] },
      });
    },
    {
      name: 'createCase',
      description:
        'Create a Case (support issue or escalation) in Zoho CRM for emails containing complaints, disputes, or technical problems.',
      schema: z.object({
        Subject: z.string().describe('Case subject/title'),
        Description: z
          .string()
          .optional()
          .describe('Detailed description of the issue'),
        Priority: z.enum(['High', 'Medium', 'Low']).optional(),
        Status: z
          .enum(['New', 'On hold', 'Escalated', 'Open', 'Closed'])
          .optional()
          .default('New'),
        contact_id: z
          .string()
          .optional()
          .describe('Contact record ID to link this case to'),
        summary: SUMMARY,
      }),
    },
  );

  return {
    readTools: [searchLeads, searchContacts],
    writeTools: [
      createLead,
      updateLead,
      updateContact,
      createTask,
      createNote,
      createDeal,
      createCase,
    ],
  };
}
