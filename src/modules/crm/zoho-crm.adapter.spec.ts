/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
// The MCP client is mocked wholesale, so its tool objects arrive untyped. Same
// treatment crm.service.spec.ts gives the HubSpot SDK mock.
import { ZohoMcpAdapter } from './zoho-crm.adapter';

const mockGetTools = jest.fn();
jest.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: jest.fn().mockImplementation(() => ({
    getTools: () => mockGetTools(),
  })),
}));

const mkTool = (name: string, invoke: jest.Mock) => ({ name, invoke });

/** What the adapter passes to an MCP tool. Typed so the mocks are not `any`. */
interface McpCall {
  path_variables: { module: string };
  query_params?: Record<string, unknown>;
}

describe('ZohoMcpAdapter', () => {
  let adapter: ZohoMcpAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new ZohoMcpAdapter('https://zoho.test/mcp/x');
  });

  const envelope = (records: unknown[]) => ({ data: records });

  describe('fetchContacts', () => {
    it('reads both modules and de-duplicates by email', async () => {
      const invoke = jest
        .fn()
        .mockImplementation(({ path_variables }: McpCall) =>
          Promise.resolve(
            path_variables.module === 'Contacts'
              ? envelope([
                  {
                    id: 'c-1',
                    Email: 'shared@acme.co',
                    Account_Name: { name: 'Acme' },
                  },
                ])
              : envelope([
                  { id: 'l-9', Email: 'SHARED@acme.co', Company: 'Stale' },
                  {
                    id: 'l-2',
                    Email: 'lead@acme.co',
                    Lead_Status: 'Pre-Qualified',
                  },
                ]),
          ),
        );
      mockGetTools.mockResolvedValue([mkTool('ZohoCRM_getRecords', invoke)]);

      const res = await adapter.fetchContacts();

      // Contacts is read first, so the account-attached row wins the collision.
      expect(res).toHaveLength(2);
      expect(res[0]).toMatchObject({ crmId: 'c-1', company: 'Acme' });
      expect(res[1]).toMatchObject({ crmId: 'l-2', status: 'qualified' });
    });

    it('falls back to a search when the server exposes no lister', async () => {
      const invoke = jest.fn().mockResolvedValue(envelope([]));
      mockGetTools.mockResolvedValue([mkTool('ZohoCRM_searchRecords', invoke)]);

      await adapter.fetchContacts();

      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          query_params: expect.objectContaining({
            criteria: '(Email:not_equal:null)',
          }),
        }),
      );
    });

    // Half an address book beats none — the credential was already proved.
    it('keeps the modules that worked when one fails', async () => {
      const invoke = jest
        .fn()
        .mockImplementation(({ path_variables }) =>
          path_variables.module === 'Contacts'
            ? Promise.reject(new Error('module not accessible'))
            : Promise.resolve(envelope([{ id: 'l-1', Email: 'lead@acme.co' }])),
        );
      mockGetTools.mockResolvedValue([mkTool('ZohoCRM_getRecords', invoke)]);

      const res = await adapter.fetchContacts();

      expect(res).toHaveLength(1);
      expect(res[0].crmId).toBe('l-1');
    });

    it('throws a message the tenant can act on when nothing can read', async () => {
      mockGetTools.mockResolvedValue([
        mkTool('ZohoCRM_createRecords', jest.fn()),
      ]);

      await expect(adapter.fetchContacts()).rejects.toThrow(/read permission/);
    });
  });

  describe('getContactByEmail', () => {
    it('finds a Contact', async () => {
      const invoke = jest
        .fn()
        .mockResolvedValue(envelope([{ id: 'c-7', Email: 'a@b.co' }]));
      mockGetTools.mockResolvedValue([mkTool('ZohoCRM_searchRecords', invoke)]);

      await expect(adapter.getContactByEmail('a@b.co')).resolves.toEqual({
        id: 'c-7',
      });
    });

    it('falls through to Leads when Contacts has nothing', async () => {
      const invoke = jest
        .fn()
        .mockImplementation(({ path_variables }) =>
          Promise.resolve(
            path_variables.module === 'Leads'
              ? envelope([{ id: 'l-3', Email: 'a@b.co' }])
              : envelope([]),
          ),
        );
      mockGetTools.mockResolvedValue([mkTool('ZohoCRM_searchRecords', invoke)]);

      await expect(adapter.getContactByEmail('a@b.co')).resolves.toEqual({
        id: 'l-3',
      });
    });

    it('returns null when neither module knows the address', async () => {
      const invoke = jest.fn().mockResolvedValue(envelope([]));
      mockGetTools.mockResolvedValue([mkTool('ZohoCRM_searchRecords', invoke)]);

      await expect(adapter.getContactByEmail('a@b.co')).resolves.toBeNull();
    });
  });
});
