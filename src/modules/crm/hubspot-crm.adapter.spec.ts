/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { ConfigService } from '@nestjs/config';
import { HubSpotAdapter } from './hubspot-crm.adapter';
import { makeMockClient } from './crm.test-fixtures';

const mockDoSearch = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockNoteCreate = jest.fn();

jest.mock('@hubspot/api-client', () => ({
  Client: jest.fn().mockImplementation(() => ({
    crm: {
      contacts: {
        searchApi: { doSearch: mockDoSearch },
        basicApi: { create: mockCreate, update: mockUpdate },
      },
      objects: { notes: { basicApi: { create: mockNoteCreate } } },
    },
  })),
  AssociationTypes: { noteToContact: 202 },
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
    it('creates a new contact when the email is not found (no duplicate)', async () => {
      mockDoSearch.mockResolvedValue({ results: [] });
      mockCreate.mockResolvedValue({ id: 'new-contact-1' });

      const id = await adapter.syncContact(
        makeMockClient({ email: 'new@acme.com', name: 'Jane Doe' }),
      );

      expect(id).toBe('new-contact-1');
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledTimes(1);
      // name split into firstname/lastname for HubSpot
      const arg = mockCreate.mock.calls[0][0];
      expect(arg.properties).toMatchObject({
        email: 'new@acme.com',
        firstname: 'Jane',
        lastname: 'Doe',
        company: 'Acme',
      });
    });

    it('updates the existing contact when the email is found (not a new one)', async () => {
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

    it('propagates HubSpot errors so the worker can retry (no swallowing)', async () => {
      mockDoSearch.mockRejectedValue(new Error('HubSpot 401 invalid key'));

      await expect(adapter.syncContact(makeMockClient())).rejects.toThrow(
        'HubSpot 401 invalid key',
      );
    });
  });

  describe('logNote', () => {
    it('creates a note associated to the given contact id', async () => {
      mockNoteCreate.mockResolvedValue({ id: 'note-1' });

      await adapter.logNote('contact-77', 'Followed up by email');

      expect(mockNoteCreate).toHaveBeenCalledTimes(1);
      const arg = mockNoteCreate.mock.calls[0][0];
      expect(arg.properties.hs_note_body).toBe('Followed up by email');
      expect(arg.associations[0].to.id).toBe('contact-77');
      expect(arg.associations[0].types[0].associationTypeId).toBe(202);
    });
  });
});
