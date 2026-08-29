import { buildTools } from './tools.factory';

/** What a Zoho tool sends to the MCP layer. Typed so the mocks are not `any`. */
interface McpUpdateCall {
  path_variables: { module: string };
  body: { data: Array<Record<string, unknown>> };
}

const firstCall = (m: jest.Mock): McpUpdateCall => {
  const calls = m.mock.calls as unknown as McpUpdateCall[][];
  return calls[0][0];
};

/** The three MCP primitives every Zoho tool is built from. */
/** Zoho answers with a single MCP content object whose records sit in a string. */
const zohoReply = (records: unknown[]) => ({
  type: 'text',
  text: JSON.stringify({ data: records }),
});

const primitives = () => ({
  searchRecords: { invoke: jest.fn().mockResolvedValue(zohoReply([])) },
  createRecords: { invoke: jest.fn().mockResolvedValue({ data: [] }) },
  updateRecords: { invoke: jest.fn().mockResolvedValue({ data: [] }) },
});

const toolNamed = (built: ReturnType<typeof buildTools>, name: string) =>
  [...built.readTools, ...built.writeTools].find((t) => t.name === name)!;

describe('buildTools — Zoho', () => {
  // An approved "update the company name and job title" wrote nothing, because
  // the schema carried neither field. The panel reported success regardless.
  describe('updateLead can write what the prompt asks it to reconcile', () => {
    it('passes Company, Designation and Phone through to Zoho', async () => {
      const mcp = primitives();
      const tool = toolNamed(buildTools(mcp as never), 'updateLead');

      await tool.invoke({
        id: 'lead-1',
        Company: 'Delta Industrial Park',
        Designation: 'Procurement Manager',
        Phone: '+20 100 555 0142',
        summary: 'correct the company',
      });

      expect(mcp.updateRecords.invoke).toHaveBeenCalledWith({
        path_variables: { module: 'Leads' },
        body: {
          data: [
            {
              id: 'lead-1',
              Company: 'Delta Industrial Park',
              Designation: 'Procurement Manager',
              Phone: '+20 100 555 0142',
            },
          ],
        },
      });
    });

    it('still carries Lead_Status and Description', async () => {
      const mcp = primitives();
      const tool = toolNamed(buildTools(mcp as never), 'updateLead');

      await tool.invoke({
        id: 'lead-1',
        Lead_Status: 'Qualified',
        Description: 'Budget confirmed',
        summary: 's',
      });

      expect(firstCall(mcp.updateRecords.invoke).body.data[0]).toMatchObject({
        Lead_Status: 'Qualified',
        Description: 'Budget confirmed',
      });
    });

    // `summary` is for the human reviewing the action, not for Zoho.
    it('never sends summary to the CRM', async () => {
      const mcp = primitives();
      const tool = toolNamed(buildTools(mcp as never), 'updateLead');

      await tool.invoke({ id: 'lead-1', Company: 'Acme', summary: 'do it' });

      expect(
        firstCall(mcp.updateRecords.invoke).body.data[0],
      ).not.toHaveProperty('summary');
    });
  });

  describe('updateContact', () => {
    it('passes Title and Phone through to Zoho', async () => {
      const mcp = primitives();
      const tool = toolNamed(buildTools(mcp as never), 'updateContact');

      await tool.invoke({
        id: 'contact-1',
        Title: 'Head of Operations',
        Phone: '+20 111 555 0303',
        summary: 'role change',
      });

      expect(mcp.updateRecords.invoke).toHaveBeenCalledWith({
        path_variables: { module: 'Contacts' },
        body: {
          data: [
            {
              id: 'contact-1',
              Title: 'Head of Operations',
              Phone: '+20 111 555 0303',
            },
          ],
        },
      });
    });

    // Moving someone between companies is not something to infer from a
    // signature, and on a Contact it is a lookup rather than a text field.
    it('does not expose Account_Name', () => {
      const mcp = primitives();
      const tool = toolNamed(buildTools(mcp as never), 'updateContact');
      expect(JSON.stringify(tool.schema)).not.toContain('Account_Name');
    });
  });

  it('exposes the nine tools the agent expects', () => {
    const built = buildTools(primitives() as never);
    const names = [...built.readTools, ...built.writeTools].map((t) => t.name);
    expect(names.sort()).toEqual(
      [
        'createCase',
        'createDeal',
        'createLead',
        'createNote',
        'createTask',
        'searchContacts',
        'searchLeads',
        'updateContact',
        'updateLead',
      ].sort(),
    );
  });

  // Zoho validates per record, so one malformed Phone threw away the company
  // and job title sent with it — and reached the panel as a success.
  describe('a mangled phone does not take the record down with it', () => {
    it('truncates the prose the model appended', async () => {
      const mcp = primitives();
      const tool = toolNamed(buildTools(mcp as never), 'updateLead');

      await tool.invoke({
        id: 'lead-1',
        Company: 'Horus Renewables',
        Phone: '+20 122 555 0987, based in New Cairo',
        summary: 's',
      });

      expect(firstCall(mcp.updateRecords.invoke).body.data[0]).toMatchObject({
        Company: 'Horus Renewables',
        Phone: '+20 122 555 0987',
      });
    });

    it('omits the field entirely when there is no number in it', async () => {
      const mcp = primitives();
      const tool = toolNamed(buildTools(mcp as never), 'updateLead');

      await tool.invoke({
        id: 'lead-1',
        Company: 'Horus Renewables',
        Phone: 'see signature',
        summary: 's',
      });

      const sent = firstCall(mcp.updateRecords.invoke).body.data[0];
      expect(sent).toMatchObject({ Company: 'Horus Renewables' });
      expect(sent).not.toHaveProperty('Phone');
    });

    it('leaves a clean number alone', async () => {
      const mcp = primitives();
      const tool = toolNamed(buildTools(mcp as never), 'createLead');

      await tool.invoke({
        Last_Name: 'Sobhy',
        Email: 't@x.co',
        Company: 'Horus',
        Phone: '+20 122 555 0987',
        summary: 's',
      });

      expect(firstCall(mcp.createRecords.invoke).body.data[0]).toMatchObject({
        Phone: '+20 122 555 0987',
      });
    });
  });

  // `found` was computed from the raw payload, which for Zoho is a single
  // always-truthy object — so every search reported found: 1. The model then
  // believed a record existed, had no id to use, and INVENTED one
  // ("1234567890123456789"), passing it to updateContact, createTask and
  // createDeal. Seen live on 29 Aug against a sender who was in neither module.
  describe('search reports what was actually found', () => {
    it('reports found: 0 for an empty result', async () => {
      const mcp = primitives();
      const tool = toolNamed(buildTools(mcp as never), 'searchContacts');

      const out = (await tool.invoke({ email: 'nobody@nowhere.test' })) as {
        found: number;
        records: unknown[];
      };

      expect(out.found).toBe(0);
      expect(out.records).toEqual([]);
    });

    it('reports the real count and surfaces the id', async () => {
      const mcp = primitives();
      mcp.searchRecords.invoke.mockResolvedValue(
        zohoReply([
          {
            id: '7521201000000711001',
            Full_Name: 'Tarek Sobhy',
            Email: 't@x.co',
            Company: 'Horus Renewables',
          },
        ]),
      );
      const tool = toolNamed(buildTools(mcp as never), 'searchLeads');

      const out = (await tool.invoke({ email: 't@x.co' })) as {
        found: number;
        records: Array<{ id: string }>;
      };

      expect(out.found).toBe(1);
      expect(out.records[0].id).toBe('7521201000000711001');
    });

    it('tells the model never to invent an id', () => {
      const built = buildTools(primitives() as never);
      const search = toolNamed(built, 'searchContacts');
      expect(search.description).toMatch(/never invent or guess an id/i);
    });
  });
});
