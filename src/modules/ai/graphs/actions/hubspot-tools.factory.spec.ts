/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import type { Client } from '@hubspot/api-client';
import type { StructuredTool } from 'langchain';
import {
  buildHubSpotTools,
  fetchDealStages,
  type HubSpotDealStage,
} from './hubspot-tools.factory';

const mockContactSearch = jest.fn();
const mockContactCreate = jest.fn();
const mockContactUpdate = jest.fn();
const mockTaskCreate = jest.fn();
const mockNoteCreate = jest.fn();
const mockTicketCreate = jest.fn();
const mockDealCreate = jest.fn();
const mockPipelinesGetAll = jest.fn();

function makeClient(): Client {
  return {
    crm: {
      contacts: {
        searchApi: { doSearch: mockContactSearch },
        basicApi: { create: mockContactCreate, update: mockContactUpdate },
      },
      deals: { basicApi: { create: mockDealCreate } },
      tickets: { basicApi: { create: mockTicketCreate } },
      objects: {
        tasks: { basicApi: { create: mockTaskCreate } },
        notes: { basicApi: { create: mockNoteCreate } },
      },
      pipelines: { pipelinesApi: { getAll: mockPipelinesGetAll } },
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
    });

    expect(writeTools.map((t) => t.name)).not.toContain('createDeal');
    // Everything that does not depend on a stage id must survive.
    expect(writeTools).toHaveLength(5);
  });

  it('never exposes a write tool without a summary field for the reviewer', () => {
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
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

  it('does not invent an amount that the email never stated', async () => {
    mockDealCreate.mockResolvedValue({ id: 'deal-3' });
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
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
    });

    const out = await byName(readTools, 'searchContacts').invoke({
      email: 'a@b.com',
    });

    expect(out).toEqual([
      { id: 'contact-9', email: 'a@b.com', firstname: 'Omar' },
    ]);
  });

  it('omits fields the model left blank instead of writing empty strings over real data', async () => {
    mockContactUpdate.mockResolvedValue({ id: 'contact-9', properties: {} });
    const { writeTools } = buildHubSpotTools({
      client: makeClient(),
      dealStages: STAGES,
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
