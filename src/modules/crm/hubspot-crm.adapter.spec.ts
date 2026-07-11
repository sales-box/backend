/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { ConfigService } from '@nestjs/config';
import { HubSpotAdapter } from './hubspot-crm.adapter';
import { makeMockClient } from './crm.test-fixtures';

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

  describe('syncContact', () => {
    it('creates a new contact when the email is not found', async () => {
      mockDoSearch.mockResolvedValue({ results: [] });
      mockCreate.mockResolvedValue({ id: 'new-contact-1' });

      const id = await adapter.syncContact(
        makeMockClient({ email: 'new@acme.com', name: 'Jane Doe' }),
      );

      expect(id).toBe('new-contact-1');
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const arg = mockCreate.mock.calls[0][0];
      expect(arg.properties).toMatchObject({
        email: 'new@acme.com',
        firstname: 'Jane',
        lastname: 'Doe',
        company: 'Acme',
      });
    });

    it('updates the existing contact when found', async () => {
      mockDoSearch.mockResolvedValue({ results: [{ id: 'existing-9' }] });
      mockUpdate.mockResolvedValue({ id: 'existing-9' });

      const id = await adapter.syncContact(
        makeMockClient({ email: 'known@acme.com' }),
      );

      expect(id).toBe('existing-9');
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalledWith(
        'existing-9',
        expect.objectContaining({
          properties: expect.objectContaining({ email: 'known@acme.com' }),
        }),
      );
    });

    it('omits company when the client has none', async () => {
      mockDoSearch.mockResolvedValue({ results: [] });
      mockCreate.mockResolvedValue({ id: 'new-2' });

      await adapter.syncContact(makeMockClient({ company: null }));

      const arg = mockCreate.mock.calls[0][0];
      expect(arg.properties).not.toHaveProperty('company');
    });

    it('propagates HubSpot errors so the worker can retry', async () => {
      mockDoSearch.mockRejectedValue(new Error('HubSpot 401'));

      await expect(adapter.syncContact(makeMockClient())).rejects.toThrow(
        'HubSpot 401',
      );
    });
  });

  describe('createOrUpdateDeal', () => {
    it('creates a new deal when none exists with that name', async () => {
      mockDealSearch.mockResolvedValue({ results: [] });
      mockDealCreate.mockResolvedValue({ id: 'deal-1' });

      const id = await adapter.createOrUpdateDeal(
        'contact-1',
        'product_inquiry',
        'Solar Panel Pricing',
        'Acme Corp',
      );

      expect(id).toBe('deal-1');
      expect(mockDealUpdate).not.toHaveBeenCalled();
      const arg = mockDealCreate.mock.calls[0][0];
      expect(arg.properties.dealname).toBe('Acme Corp — Solar Panel Pricing');
      expect(arg.properties.dealstage).toBe('presentationscheduled');
      expect(arg.associations[0].to.id).toBe('contact-1');
    });

    it('updates stage when a deal with that name already exists', async () => {
      mockDealSearch.mockResolvedValue({ results: [{ id: 'deal-5' }] });
      mockDealUpdate.mockResolvedValue({ id: 'deal-5' });

      const id = await adapter.createOrUpdateDeal(
        'contact-1',
        'meeting_request',
        'Demo',
        'Acme',
      );

      expect(id).toBe('deal-5');
      expect(mockDealCreate).not.toHaveBeenCalled();
      expect(mockDealUpdate).toHaveBeenCalledWith('deal-5', {
        properties: { dealstage: 'appointmentscheduled' },
      });
    });

    it('is idempotent — same name twice = 1 deal', async () => {
      mockDealSearch.mockResolvedValue({ results: [{ id: 'deal-5' }] });
      mockDealUpdate.mockResolvedValue({ id: 'deal-5' });

      await adapter.createOrUpdateDeal('c-1', 'product_inquiry', 'X', 'Y');
      await adapter.createOrUpdateDeal('c-1', 'product_inquiry', 'X', 'Y');

      expect(mockDealCreate).not.toHaveBeenCalled();
    });

    it('propagates errors so the worker can retry', async () => {
      mockDealSearch.mockRejectedValue(new Error('Deals API down'));

      await expect(
        adapter.createOrUpdateDeal('c-1', 'product_inquiry', 'X', 'Y'),
      ).rejects.toThrow('Deals API down');
    });
  });

  describe('logEngagementNote', () => {
    it('creates a structured note with all payload fields', async () => {
      mockNoteCreate.mockResolvedValue({ id: 'note-1' });

      await adapter.logEngagementNote('contact-77', {
        subject: 'Pricing Request',
        summary: 'Client asked about bulk pricing',
        classification: 'product_inquiry',
        sentAt: '2026-07-09T10:00:00Z',
      });

      expect(mockNoteCreate).toHaveBeenCalledTimes(1);
      const arg = mockNoteCreate.mock.calls[0][0];
      expect(arg.properties.hs_note_body).toContain('Subject: Pricing Request');
      expect(arg.properties.hs_note_body).toContain(
        'Classification: product_inquiry',
      );
      expect(arg.properties.hs_note_body).toContain(
        'Summary: Client asked about bulk pricing',
      );
      expect(arg.associations[0].to.id).toBe('contact-77');
      expect(arg.associations[0].types[0].associationTypeId).toBe(202);
    });

    it('propagates errors so the worker can retry', async () => {
      mockNoteCreate.mockRejectedValue(new Error('Notes API down'));

      await expect(
        adapter.logEngagementNote('contact-77', {
          subject: 'x',
          summary: 'y',
          classification: 'z',
          sentAt: 'now',
        }),
      ).rejects.toThrow('Notes API down');
    });
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
            },
          },
          {
            id: 'c-2',
            properties: {
              email: 'jane@acme.com',
              firstname: 'Jane',
              lastname: '',
              company: 'Acme Corp',
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
        },
        {
          email: 'jane@acme.com',
          name: 'Jane',
          company: 'Acme Corp',
          crmId: 'c-2',
        },
      ]);
    });
  });
});
