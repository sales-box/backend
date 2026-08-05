import { tool, StructuredTool } from 'langchain';
import { z } from 'zod';

interface McpTools {
  searchRecords: StructuredTool;
  createRecords: StructuredTool;
  updateRecords: StructuredTool;
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

  const searchLeads = tool(
    async ({ email }): Promise<unknown> =>
      mcp.searchRecords.invoke({
        path_variables: { module: 'Leads' },
        query_params: { email },
      }),
    {
      name: 'searchLeads',
      description:
        'Search Zoho CRM Leads by sender email. Returns matching records or an empty array if not found.',
      schema: z.object({
        email: z.string().describe("The sender's email address to search for"),
      }),
    },
  );

  const searchContacts = tool(
    async ({ email }): Promise<unknown> =>
      mcp.searchRecords.invoke({
        path_variables: { module: 'Contacts' },
        query_params: { email },
      }),
    {
      name: 'searchContacts',
      description:
        'Search Zoho CRM Contacts by sender email. Returns matching records or an empty array if not found.',
      schema: z.object({
        email: z.string().describe("The sender's email address to search for"),
      }),
    },
  );

  const createLead = tool(
    async ({ summary: _summary, ...fields }): Promise<unknown> =>
      mcp.createRecords.invoke({
        path_variables: { module: 'Leads' },
        body: { data: [fields] },
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
        body: { data: [fields] },
      }),
    {
      name: 'updateLead',
      description:
        'Update an existing Lead record. Use to change status or add description context after receiving an email.',
      schema: z.object({
        id: z.string().describe('Zoho Lead record ID from searchLeads result'),
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
        body: { data: [fields] },
      }),
    {
      name: 'updateContact',
      description:
        'Update an existing Contact record. Use to add description context after receiving an email.',
      schema: z.object({
        id: z
          .string()
          .describe('Zoho Contact record ID from searchContacts result'),
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
