import { ConfigService } from '@nestjs/config';
import { HubSpotAdapter } from './hubspot-crm.adapter';

const mockDoSearch = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockGetPage = jest.fn();
const mockNoteCreate = jest.fn();
const mockDealSearch = jest.fn();
const mockDealCreate = jest.fn();
const mockDealUpdate = jest.fn();

jest.mock('@hubspot/api-client', () => ({
  Client: jest.fn().mockImplementation(() => ({
    crm: {
      contacts: {
        searchApi: { doSearch: mockDoSearch },
        basicApi: {
          create: mockCreate,
          update: mockUpdate,
          getPage: mockGetPage,
        },
      },
      deals: {
        searchApi: { doSearch: mockDealSearch },
        basicApi: { create: mockDealCreate, update: mockDealUpdate },
      },
      objects: { notes: { basicApi: { create: mockNoteCreate } } },
    },
  })),
  AssociationTypes: { noteToContact: 202, dealToContact: 3 },
}));

function makeAdapter(): HubSpotAdapter {
  const config = {
    getOrThrow: () => 'fake-hubspot-key',
  } as unknown as ConfigService;
  return new HubSpotAdapter(config);
}

describe('HubSpotAdapter', () => {
  let adapter: HubSpotAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = makeAdapter();
  });

  describe('getContactByEmail', () => {
    it('returns contact object if email search matches', async () => {
      mockDoSearch.mockResolvedValue({ results: [{ id: 'crm-contact-id' }] });

      const res = await adapter.getContactByEmail('test@acme.com');

      expect(res).toEqual({ id: 'crm-contact-id' });
      expect(mockDoSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          filterGroups: [
            expect.objectContaining({
              filters: [
                expect.objectContaining({
                  propertyName: 'email',
                  value: 'test@acme.com',
                }),
              ],
            }),
          ],
        }),
      );
    });

    it('returns null if email search yields no results', async () => {
      mockDoSearch.mockResolvedValue({ results: [] });

      const res = await adapter.getContactByEmail('notfound@acme.com');

      expect(res).toBeNull();
    });
  });

  describe('fetchContacts', () => {
    it('gets a page of contacts and maps them correctly', async () => {
      mockGetPage.mockResolvedValue({
        results: [
          {
            id: 'c-1',
            properties: {
              email: 'john@acme.com',
              firstname: 'John',
              lastname: 'Doe',
              company: 'Acme',
              lifecyclestage: 'customer',
            },
          },
          {
            id: 'c-2',
            properties: {
              email: 'jane@acme.com',
              firstname: 'Jane',
              lastname: '',
              company: 'Acme Corp',
              lifecyclestage: 'salesqualifiedlead',
            },
          },
          {
            id: 'c-3',
            properties: {
              email: '', // should be filtered out
            },
          },
        ],
      });

      const res = await adapter.fetchContacts();

      expect(res).toEqual([
        {
          email: 'john@acme.com',
          name: 'John Doe',
          company: 'Acme',
          crmId: 'c-1',
          status: 'customer',
        },
        {
          email: 'jane@acme.com',
          name: 'Jane',
          company: 'Acme Corp',
          crmId: 'c-2',
          status: 'qualified',
        },
      ]);
    });

    it('asks HubSpot for lifecyclestage', async () => {
      mockGetPage.mockResolvedValue({ results: [] });

      await adapter.fetchContacts();

      expect(mockGetPage).toHaveBeenCalledWith(
        100,
        undefined,
        expect.arrayContaining(['lifecyclestage']),
      );
    });

    it('leaves status undefined when the stage is missing or unknown', async () => {
      mockGetPage.mockResolvedValue({
        results: [
          { id: 'c-4', properties: { email: 'no-stage@acme.com' } },
          {
            id: 'c-5',
            properties: { email: 'custom@acme.com', lifecyclestage: '9912' },
          },
        ],
      });

      const res = await adapter.fetchContacts();

      expect(res.map((c) => c.status)).toEqual([undefined, undefined]);
    });
  });
});
