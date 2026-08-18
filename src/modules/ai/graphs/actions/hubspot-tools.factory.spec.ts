/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import type { Client } from '@hubspot/api-client';
import type { StructuredTool } from 'langchain';
import {
  buildHubSpotTools,
  fetchDealStages,
  fetchSoleOwnerId,
  probeTicketsAvailable,
  type HubSpotDealStage,
} from './hubspot-tools.factory';

const mockContactSearch = jest.fn();
const mockContactCreate = jest.fn();
const mockContactUpdate = jest.fn();
const mockTaskCreate = jest.fn();
const mockNoteCreate = jest.fn();
const mockTicketCreate = jest.fn();
const mockDealCreate = jest.fn();
const mockTicketGetPage = jest.fn();
const mockContactGetById = jest.fn();
const mockOwnersGetPage = jest.fn();
const mockPipelinesGetAll = jest.fn();

function makeClient(): Client {
  return {
    crm: {
      contacts: {
        searchApi: { doSearch: mockContactSearch },
        basicApi: {
          create: mockContactCreate,
          update: mockContactUpdate,
          getById: mockContactGetById,
        },
      },
      deals: { basicApi: { create: mockDealCreate } },
      tickets: {
        basicApi: { create: mockTicketCreate, getPage: mockTicketGetPage },
      },
      objects: {
        tasks: { basicApi: { create: mockTaskCreate } },
        notes: { basicApi: { create: mockNoteCreate } },
      },
      pipelines: { pipelinesApi: { getAll: mockPipelinesGetAll } },
      owners: { ownersApi: { getPage: mockOwnersGetPage } },
    },
  } as unknown as Client;
}

const STAGES: HubSpotDealStage[] = [
  {
    id: 'appointmentscheduled',
    label: 'Appointment Scheduled',
    pipelineId: 'default',
  },
  { id: '1049283', label: 'Site Survey', pipelineId: 'custom-pipeline' },
];

function byName(tools: StructuredTool[], name: string): StructuredTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

beforeEach(() => jest.clearAllMocks());

describe('probeTicketsAvailable', () => {
  it('is true when the portal answers', async () => {
    mockTicketGetPage.mockResolvedValue({ results: [] });
    await expect(probeTicketsAvailable(makeClient())).resolves.toBe(true);
  });

  it('is false when the portal refuses, without throwing', async () => {
    mockTicketGetPage.mockRejectedValue(
      Object.assign(new Error('scope not available for public use'), {
        code: 403,
      }),
    );
    await expect(probeTicketsAvailable(makeClient())).resolves.toBe(false);
  });
});

describe('fetchDealStages', () => {
  it('flattens every pipeline into stages that remember which pipeline they came from', async () => {
    mockPipelinesGetAll.mockResolvedValue({
      results: [
        {
          id: 'default',
          stages: [
            { id: 'appointmentscheduled', label: 'Appointment Scheduled' },
            { id: 'closedwon', label: 'Closed Won' },
          ],
        },
        {
          id: 'custom-pipeline',
          stages: [{ id: '1049283', label: 'Site Survey' }],
        },
      ],
    });

    await expect(fetchDealStages(makeClient())).resolves.toEqual([
      {
        id: 'appointmentscheduled',
        label: 'Appointment Scheduled',
        pipelineId: 'default',
      },
      { id: 'closedwon', label: 'Closed Won', pipelineId: 'default' },
      { id: '1049283', label: 'Site Survey', pipelineId: 'custom-pipeline' },
    ]);
    expect(mockPipelinesGetAll).toHaveBeenCalledWith('deals');
  });
});

describe('buildHubSpotTools — shape', () => {
  it('exposes one read tool and the write tools the approval gate will interrupt on', () => {
    const { readTools, writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    expect(readTools.map((t) => t.name)).toEqual(['searchContacts']);
    expect(writeTools.map((t) => t.name)).toEqual([
      'createContact',
      'updateContact',
      'createTask',
      'createNote',
      'createTicket',
      'createDeal',
    ]);
  });

  it('drops createDeal when the portal stages could not be read', () => {
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: [],
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    expect(writeTools.map((t) => t.name)).not.toContain('createDeal');
    // Everything that does not depend on a stage id must survive.
    expect(writeTools).toHaveLength(5);
  });

  it('drops createTicket on a portal that cannot use Tickets', () => {
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: false,
      defaultOwnerId: null,
    });

    expect(writeTools.map((t) => t.name)).not.toContain('createTicket');
    // Approving a ticket that then 403s is worse than never offering it: the
    // SE believes the escalation was logged.
    expect(writeTools.map((t) => t.name)).toEqual([
      'createContact',
      'updateContact',
      'createTask',
      'createNote',
      'createDeal',
    ]);
  });

  it('never exposes a write tool without a summary field for the reviewer', () => {
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    for (const t of writeTools) {
      expect(Object.keys((t.schema as any).shape)).toContain('summary');
    }
  });
});

describe('buildHubSpotTools — associations (the orphaned-record gap)', () => {
  it('attaches a task to the contact', async () => {
    mockTaskCreate.mockResolvedValue({ id: 'task-1' });
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    await byName(writeTools, 'createTask').invoke({
      subject: 'Send the revised quote',
      due_date: '2026-08-27',
      contact_id: 'contact-9',
      summary: 'Follow up with a quote.',
    });

    const [payload] = mockTaskCreate.mock.calls[0];
    expect(payload.associations[0].to).toEqual({ id: 'contact-9' });
    expect(payload.associations[0].types[0].associationTypeId).toBe(204);
  });

  it('attaches a ticket to the contact', async () => {
    mockTicketCreate.mockResolvedValue({ id: 'ticket-1' });
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    await byName(writeTools, 'createTicket').invoke({
      subject: 'Inverter down eleven days',
      contact_id: 'contact-9',
      summary: 'Log the escalation.',
    });

    const [payload] = mockTicketCreate.mock.calls[0];
    expect(payload.associations[0].types[0].associationTypeId).toBe(16);
  });

  it('attaches a deal to the contact', async () => {
    mockDealCreate.mockResolvedValue({ id: 'deal-1' });
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    await byName(writeTools, 'createDeal').invoke({
      dealname: 'Phase 2 rooftop',
      dealstage: 'appointmentscheduled',
      contact_id: 'contact-9',
      summary: 'Open the opportunity.',
    });

    const [payload] = mockDealCreate.mock.calls[0];
    expect(payload.associations[0].types[0].associationTypeId).toBe(3);
  });

  it('still creates a task when the sender is unknown, rather than refusing', async () => {
    mockTaskCreate.mockResolvedValue({ id: 'task-2' });
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    await byName(writeTools, 'createTask').invoke({
      subject: 'Research the new prospect',
      due_date: '2026-08-27',
      summary: 'Follow up.',
    });

    expect(mockTaskCreate.mock.calls[0][0].associations).toEqual([]);
  });
});

describe('buildHubSpotTools — per-portal deal stages', () => {
  it('sends the pipeline that owns the chosen stage, not a hardcoded default', async () => {
    mockDealCreate.mockResolvedValue({ id: 'deal-2' });
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    await byName(writeTools, 'createDeal').invoke({
      dealname: 'Survey job',
      dealstage: '1049283',
      summary: 'Open the opportunity.',
    });

    expect(mockDealCreate.mock.calls[0][0].properties).toMatchObject({
      dealstage: '1049283',
      pipeline: 'custom-pipeline',
    });
  });

  it('rejects a stage this portal does not have, and names the ones it does', async () => {
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    await expect(
      byName(writeTools, 'createDeal').invoke({
        dealname: 'Guessed stage',
        dealstage: 'qualifiedtobuy',
        summary: 'Open the opportunity.',
      }),
    ).rejects.toThrow(/Site Survey/);
    expect(mockDealCreate).not.toHaveBeenCalled();
  });

  it('treats a zero amount as unknown rather than writing a worthless deal', async () => {
    // HubSpot sums amount across the pipeline. "0" reports a real opportunity
    // as worth nothing; unset reports it as not yet valued.
    mockDealCreate.mockResolvedValue({ id: 'deal-4' });
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    await byName(writeTools, 'createDeal').invoke({
      dealname: 'Early stage enquiry',
      dealstage: 'appointmentscheduled',
      amount: 0,
      summary: 'Open the opportunity.',
    });

    expect(mockDealCreate.mock.calls[0][0].properties).not.toHaveProperty(
      'amount',
    );
  });

  it('does not invent an amount that the email never stated', async () => {
    mockDealCreate.mockResolvedValue({ id: 'deal-3' });
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    await byName(writeTools, 'createDeal').invoke({
      dealname: 'No figure given',
      dealstage: 'appointmentscheduled',
      summary: 'Open the opportunity.',
    });

    expect(mockDealCreate.mock.calls[0][0].properties).not.toHaveProperty(
      'amount',
    );
  });
});

describe('fetchSoleOwnerId', () => {
  it('returns the id when the portal has exactly one owner', async () => {
    mockOwnersGetPage.mockResolvedValue({ results: [{ id: '95826980' }] });
    await expect(fetchSoleOwnerId(makeClient())).resolves.toBe('95826980');
  });

  it('returns null when several owners exist — guessing routes work to the wrong person', async () => {
    mockOwnersGetPage.mockResolvedValue({
      results: [{ id: '1' }, { id: '2' }],
    });
    await expect(fetchSoleOwnerId(makeClient())).resolves.toBeNull();
  });

  it('returns null instead of throwing when owners cannot be read', async () => {
    mockOwnersGetPage.mockRejectedValue(new Error('403'));
    await expect(fetchSoleOwnerId(makeClient())).resolves.toBeNull();
  });
});

describe('buildHubSpotTools — task ownership', () => {
  it("prefers the contact's own owner", async () => {
    mockTaskCreate.mockResolvedValue({ id: 'task-5' });
    mockContactGetById.mockResolvedValue({
      properties: { hubspot_owner_id: 'owner-of-contact' },
    });
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: 'sole-owner',
    });

    await byName(writeTools, 'createTask').invoke({
      subject: 'x',
      due_date: '2026-08-27',
      contact_id: 'contact-9',
      summary: 's',
    });

    expect(mockTaskCreate.mock.calls[0][0].properties.hubspot_owner_id).toBe(
      'owner-of-contact',
    );
  });

  it('falls back to the portal owner when the contact has none', async () => {
    mockTaskCreate.mockResolvedValue({ id: 'task-6' });
    mockContactGetById.mockResolvedValue({ properties: {} });
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: 'sole-owner',
    });

    await byName(writeTools, 'createTask').invoke({
      subject: 'x',
      due_date: '2026-08-27',
      contact_id: 'contact-9',
      summary: 's',
    });

    expect(mockTaskCreate.mock.calls[0][0].properties.hubspot_owner_id).toBe(
      'sole-owner',
    );
  });

  it('leaves the task unowned when there is no defensible owner', async () => {
    mockTaskCreate.mockResolvedValue({ id: 'task-7' });
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    await byName(writeTools, 'createTask').invoke({
      subject: 'x',
      due_date: '2026-08-27',
      summary: 's',
    });

    expect(mockTaskCreate.mock.calls[0][0].properties).not.toHaveProperty(
      'hubspot_owner_id',
    );
  });

  it('still creates the task when the contact lookup fails', async () => {
    mockTaskCreate.mockResolvedValue({ id: 'task-8' });
    mockContactGetById.mockRejectedValue(new Error('boom'));
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: 'sole-owner',
    });

    await byName(writeTools, 'createTask').invoke({
      subject: 'x',
      due_date: '2026-08-27',
      contact_id: 'contact-9',
      summary: 's',
    });

    expect(mockTaskCreate).toHaveBeenCalled();
    expect(mockTaskCreate.mock.calls[0][0].properties.hubspot_owner_id).toBe(
      'sole-owner',
    );
  });
});

describe('buildHubSpotTools — contacts', () => {
  it('returns id alongside properties so later writes can associate to it', async () => {
    mockContactSearch.mockResolvedValue({
      results: [
        {
          id: 'contact-9',
          properties: { email: 'a@b.com', firstname: 'Omar' },
        },
      ],
    });
    const { readTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    const out = await byName(readTools, 'searchContacts').invoke({
      email: 'a@b.com',
    });

    expect(out).toEqual({
      found: 1,
      contacts: [{ id: 'contact-9', email: 'a@b.com', firstname: 'Omar' }],
    });
  });

  it('omits fields the model left blank instead of writing empty strings over real data', async () => {
    mockContactUpdate.mockResolvedValue({ id: 'contact-9', properties: {} });
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    await byName(writeTools, 'updateContact').invoke({
      id: 'contact-9',
      jobtitle: 'Operations Director',
      summary: 'Correct the job title.',
    });

    expect(mockContactUpdate.mock.calls[0][1].properties).toEqual({
      jobtitle: 'Operations Director',
    });
  });

  it('never sends the reviewer summary to HubSpot as a contact property', async () => {
    mockContactCreate.mockResolvedValue({ id: 'contact-new', properties: {} });
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
      ticketsAvailable: true,
      defaultOwnerId: null,
    });

    await byName(writeTools, 'createContact').invoke({
      email: 'new@prospect.com',
      summary: 'Add the new prospect.',
    });

    expect(mockContactCreate.mock.calls[0][0].properties).not.toHaveProperty(
      'summary',
    );
  });
});
