import { tool, StructuredTool } from 'langchain';
import { z } from 'zod';
import { AssociationTypes, Client } from '@hubspot/api-client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';
import { AssociationSpecAssociationCategoryEnum } from '@hubspot/api-client/lib/codegen/crm/objects/notes';

/**
 * One deal stage as the tenant's own portal defines it.
 *
 * HubSpot deal stages are not a fixed vocabulary the way Zoho's are. Every
 * portal has its own pipelines, and the API takes the stage's *internal id*
 * (`appointmentscheduled`, or a bare number on a custom pipeline) while the
 * user only ever sees the label. Hardcoding the defaults would write records
 * that silently land in the wrong stage on any portal that renamed them, and
 * fail outright on one that deleted them.
 */
export interface HubSpotDealStage {
  /** Internal id — what the API expects in `dealstage`. */
  id: string;
  /** What the tenant sees in their portal, e.g. "Appointment Scheduled". */
  label: string;
  /** Pipeline this stage belongs to. */
  pipelineId: string;
}

export interface HubSpotToolContext {
  client: Client;
  /** Stages read from the tenant's portal. Empty means no deal tool. */
  dealStages: HubSpotDealStage[];
  /** False when this portal cannot use Tickets. Removes the ticket tool. */
  ticketsAvailable: boolean;
  /**
   * Who to assign work to when the contact has no owner of its own. Null on a
   * portal with several owners, where guessing would put the task on the wrong
   * person's list.
   */
  defaultOwnerId: string | null;
}

const CONTACT_PROPERTIES = ['email', 'firstname', 'lastname', 'company'];

/** Contact lifecycle stages, HubSpot's replacement for Zoho's Leads module. */
const LIFECYCLE_STAGES = [
  'subscriber',
  'lead',
  'marketingqualifiedlead',
  'salesqualifiedlead',
  'opportunity',
  'customer',
] as const;

/**
 * Read the deal stages a tenant's portal actually has.
 *
 * Called once when the tools are built and cached alongside them, so a normal
 * run costs no extra API call.
 */
export async function fetchDealStages(
  client: Client,
): Promise<HubSpotDealStage[]> {
  const { results } = await client.crm.pipelines.pipelinesApi.getAll('deals');

  return results.flatMap((pipeline) =>
    pipeline.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      pipelineId: pipeline.id,
    })),
  );
}

/**
 * The one owner to fall back on, when there is exactly one.
 *
 * A task with no owner is created and associated correctly, but HubSpot's task
 * list is filtered to "assigned to me" by default, so it appears in nobody's
 * queue. On a single-user portal the right owner is unambiguous. With several
 * owners it is not, and picking one would quietly route work to the wrong
 * person — worse than leaving it unassigned, so we return null and the task is
 * created without an owner exactly as before.
 */
export async function fetchSoleOwnerId(client: Client): Promise<string | null> {
  try {
    const { results } = await client.crm.owners.ownersApi.getPage(
      undefined,
      undefined,
      2,
    );
    return results.length === 1 ? results[0].id : null;
  } catch {
    return null;
  }
}

/**
 * Can this portal use Tickets at all?
 *
 * Tickets belong to Service Hub. On a portal without it, HubSpot does not just
 * withhold the scope — it reports that the scope "isn't available for public
 * use", so there is no checkbox for the tenant to tick and no way to fix it in
 * settings. Offering createTicket there produces an action the reviewer can
 * approve and that then fails, which is the worst possible ordering: the SE
 * believes an escalation was logged and it was not.
 *
 * A read probe is enough to tell the two worlds apart, and unlike a write
 * probe it cannot leave anything behind.
 */
export async function probeTicketsAvailable(client: Client): Promise<boolean> {
  try {
    await client.crm.tickets.basicApi.getPage(1, undefined, ['subject']);
    return true;
  } catch {
    return false;
  }
}

/**
 * The HubSpot half of the agent's toolset.
 *
 * Deliberately mirrors `buildTools` for Zoho: same return shape, same summary
 * field on every write, so the middleware chain and the approval gate consume
 * both without knowing which CRM produced them.
 *
 * Two things differ structurally, not cosmetically:
 *
 * 1. **Associations are explicit.** Zoho links a Deal to a Contact by putting
 *    an id in a field on the Deal. HubSpot requires a separate association
 *    with a typed id, and a record created without one is real but orphaned —
 *    it appears in no timeline and on no contact. Every write here that has a
 *    natural parent takes `contact_id` and sends the association with it.
 *
 * 2. **There is one Contacts object, not Leads and Contacts.** Whether someone
 *    is a lead is a property (`lifecyclestage`), not a separate module, so
 *    there is no `createLead`/`searchLeads` pair to mirror.
 */
export function buildHubSpotTools(ctx: HubSpotToolContext): {
  readTools: StructuredTool[];
  writeTools: StructuredTool[];
} {
  const { client, dealStages, ticketsAvailable, defaultOwnerId } = ctx;

  const SUMMARY = z
    .string()
    .describe(
      'One concise, plain-language sentence describing this action for a non-technical reviewer. ' +
        'No field names, API names, or record IDs.',
    );

  /** The association block HubSpot needs to hang a record off a contact. */
  const toContact = (contactId: string, associationTypeId: number) => [
    {
      to: { id: contactId },
      types: [
        {
          associationCategory:
            AssociationSpecAssociationCategoryEnum.HubspotDefined,
          associationTypeId,
        },
      ],
    },
  ];

  /**
   * Whose queue this task belongs in: the contact's own owner if they have one,
   * otherwise the portal's single owner. An unowned task is invisible in the
   * default "assigned to me" task view, so it gets created and then never
   * worked on.
   */
  const resolveTaskOwner = async (
    contactId?: string,
  ): Promise<string | null> => {
    if (contactId) {
      try {
        const contact = await client.crm.contacts.basicApi.getById(contactId, [
          'hubspot_owner_id',
        ]);
        const owner = contact.properties.hubspot_owner_id;
        if (owner) return owner;
      } catch {
        // The contact read is a nicety; never fail the write over it.
      }
    }
    return defaultOwnerId;
  };

  const searchContacts = tool(
    async ({ email }): Promise<unknown> => {
      const result = await client.crm.contacts.searchApi.doSearch({
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'email',
                operator: FilterOperatorEnum.Eq,
                value: email,
              },
            ],
          },
        ],
        properties: [...CONTACT_PROPERTIES, 'jobtitle', 'lifecyclestage'],
        limit: 5,
        after: '0',
        sorts: [],
      });

      // Always an object, never a bare array.
      //
      // Returning `[]` on no match produced a ToolMessage whose content was an
      // empty list, which reads to the model as no observation at all rather
      // than as "nobody matched". It re-issued the identical search 18 times
      // and the graph died on its recursion limit after 76 seconds — the panel
      // showed "No suggested actions", so a hard failure looked like a verdict.
      //
      // `found: 0` is something the model can actually read and act on.
      const contacts = result.results.map((c) => ({
        id: c.id,
        ...c.properties,
      }));
      return { found: contacts.length, contacts };
    },
    {
      name: 'searchContacts',
      description:
        'Search HubSpot Contacts by sender email. Returns { found, contacts }; ' +
        'found: 0 is a conclusive answer meaning this person is not in the CRM yet — ' +
        'do not repeat the search, treat them as a new prospect. ' +
        'HubSpot has no separate Leads object — a prospect and a customer are both Contacts, ' +
        'told apart by the lifecyclestage property.',
      schema: z.object({
        email: z.string().describe("The sender's email address to search for"),
      }),
    },
  );

  const createContact = tool(
    async ({ summary: _summary, ...properties }): Promise<unknown> => {
      const created = await client.crm.contacts.basicApi.create({
        properties: Object.fromEntries(
          Object.entries(properties).filter(([, v]) => v !== undefined),
        ),
        associations: [],
      });
      return { id: created.id, ...created.properties };
    },
    {
      name: 'createContact',
      description:
        'Create a new Contact in HubSpot. Use for email senders that searchContacts did not find.',
      schema: z.object({
        email: z.string().describe("Contact's email address"),
        firstname: z.string().optional().describe("Contact's first name"),
        lastname: z.string().optional().describe("Contact's last name"),
        company: z.string().optional().describe("Contact's company name"),
        jobtitle: z.string().optional().describe("Contact's job title"),
        phone: z.string().optional(),
        lifecyclestage: z
          .enum(LIFECYCLE_STAGES)
          .optional()
          .default('lead')
          .describe(
            'Where this person sits in the funnel. A new inbound prospect is "lead".',
          ),
        summary: SUMMARY,
      }),
    },
  );

  const updateContact = tool(
    async ({ summary: _summary, id, ...properties }): Promise<unknown> => {
      const updated = await client.crm.contacts.basicApi.update(id, {
        properties: Object.fromEntries(
          Object.entries(properties).filter(([, v]) => v !== undefined),
        ),
      });
      return { id: updated.id, ...updated.properties };
    },
    {
      name: 'updateContact',
      description:
        'Update an existing HubSpot Contact. Use to correct details or advance the lifecycle stage ' +
        'after an email, rather than creating a second record for the same person.',
      schema: z.object({
        id: z.string().describe('HubSpot Contact ID from searchContacts'),
        firstname: z.string().optional(),
        lastname: z.string().optional(),
        company: z.string().optional(),
        jobtitle: z.string().optional(),
        phone: z.string().optional(),
        lifecyclestage: z.enum(LIFECYCLE_STAGES).optional(),
        summary: SUMMARY,
      }),
    },
  );

  const createTask = tool(
    async ({
      summary: _summary,
      contact_id,
      due_date,
      subject,
      priority,
      body,
    }): Promise<unknown> => {
      const ownerId = await resolveTaskOwner(contact_id);

      const created = await client.crm.objects.tasks.basicApi.create({
        properties: {
          hs_task_subject: subject,
          hs_task_status: 'NOT_STARTED',
          hs_task_type: 'TODO',
          hs_timestamp: new Date(`${due_date}T09:00:00Z`).toISOString(),
          ...(priority ? { hs_task_priority: priority } : {}),
          ...(body ? { hs_task_body: body } : {}),
          ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
        },
        associations: contact_id
          ? toContact(contact_id, AssociationTypes.taskToContact)
          : [],
      });
      return { id: created.id };
    },
    {
      name: 'createTask',
      description:
        'Create a follow-up Task in HubSpot. Pass contact_id whenever the sender is a known Contact — ' +
        "a task without it is created but appears on nobody's timeline.",
      schema: z.object({
        subject: z.string().describe('Task subject line'),
        due_date: z.string().describe('Due date in YYYY-MM-DD format'),
        priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
        body: z.string().optional().describe('Task notes'),
        contact_id: z
          .string()
          .optional()
          .describe('HubSpot Contact ID to attach this task to'),
        summary: SUMMARY,
      }),
    },
  );

  const createNote = tool(
    async ({ summary: _summary, contact_id, note_body }): Promise<unknown> => {
      const created = await client.crm.objects.notes.basicApi.create({
        properties: {
          hs_note_body: note_body,
          hs_timestamp: new Date().toISOString(),
        },
        associations: toContact(contact_id, AssociationTypes.noteToContact),
      });
      return { id: created.id };
    },
    {
      name: 'createNote',
      description:
        'Attach a contextual Note to a HubSpot Contact. Use for background worth recording ' +
        'that needs no task, deal, or ticket of its own.',
      schema: z.object({
        note_body: z.string().describe('Note body text'),
        contact_id: z
          .string()
          .describe('HubSpot Contact ID to attach this note to — required'),
        summary: SUMMARY,
      }),
    },
  );

  const createTicket = tool(
    async ({
      summary: _summary,
      contact_id,
      subject,
      content,
      priority,
    }): Promise<unknown> => {
      const created = await client.crm.tickets.basicApi.create({
        properties: {
          subject,
          hs_pipeline_stage: '1',
          ...(content ? { content } : {}),
          ...(priority ? { hs_ticket_priority: priority } : {}),
        },
        associations: contact_id
          ? toContact(contact_id, AssociationTypes.ticketToContact)
          : [],
      });
      return { id: created.id };
    },
    {
      name: 'createTicket',
      description:
        'Create a Ticket in HubSpot for complaints, disputes, or technical problems. ' +
        "This is HubSpot's equivalent of a support case.",
      schema: z.object({
        subject: z.string().describe('Ticket subject/title'),
        content: z
          .string()
          .optional()
          .describe('Detailed description of the issue'),
        priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
        contact_id: z
          .string()
          .optional()
          .describe('HubSpot Contact ID to attach this ticket to'),
        summary: SUMMARY,
      }),
    },
  );

  /**
   * Deals need a stage id that exists in this portal, so the tool is only
   * offered when we managed to read the pipelines. Offering it with a guessed
   * stage would produce a rejected write the agent cannot diagnose.
   */
  const dealTools = dealStages.length === 0 ? [] : [buildCreateDeal()];

  function buildCreateDeal(): StructuredTool {
    const stageById = new Map(dealStages.map((s) => [s.id, s]));
    const stageList = dealStages
      .map((s) => `"${s.id}" (${s.label})`)
      .join(', ');

    // Named so the handler's arguments are inferred from it. Inlining the
    // schema below the handler leaves every destructured field as `any`.
    const dealSchema = z.object({
      dealname: z.string().describe('Deal name'),
      dealstage: z.string().describe(`Stage id. One of: ${stageList}`),
      closedate: z
        .string()
        .optional()
        .describe('Expected close date in YYYY-MM-DD format'),
      amount: z
        .number()
        .optional()
        .describe(
          'Deal value. Set ONLY if explicitly stated in the email. Never fabricate a number.',
        ),
      description: z.string().optional().describe('Context from the email'),
      contact_id: z
        .string()
        .optional()
        .describe('HubSpot Contact ID to attach this deal to'),
      summary: SUMMARY,
    });

    return tool(
      async ({
        summary: _summary,
        contact_id,
        dealname,
        dealstage,
        amount,
        closedate,
        description,
      }: z.infer<typeof dealSchema>): Promise<unknown> => {
        const stage = stageById.get(dealstage);
        if (!stage) {
          // Reachable: the model can emit a stage id outside the enum. Naming
          // the valid ids lets it retry instead of failing opaquely.
          throw new Error(
            `Unknown deal stage "${dealstage}". Valid stages: ${stageList}`,
          );
        }

        const created = await client.crm.deals.basicApi.create({
          properties: {
            dealname,
            dealstage: stage.id,
            pipeline: stage.pipelineId,
            // Zero is not a price, it is a missing price. HubSpot sums amount
            // across the pipeline, so writing "0" reports a real opportunity as
            // worth nothing; leaving it unset reports it as not yet valued.
            ...(amount !== undefined && amount > 0
              ? { amount: String(amount) }
              : {}),
            ...(closedate
              ? { closedate: new Date(`${closedate}T00:00:00Z`).toISOString() }
              : {}),
            ...(description ? { description } : {}),
          },
          associations: contact_id
            ? toContact(contact_id, AssociationTypes.dealToContact)
            : [],
        });
        return { id: created.id };
      },
      {
        name: 'createDeal',
        description:
          'Create a Deal (revenue opportunity) in HubSpot for emails that show financial intent. ' +
          `Valid dealstage values in this portal: ${stageList}. ` +
          'Pass contact_id so the deal is attached to the sender.',
        schema: dealSchema,
      },
    ) as StructuredTool;
  }

  return {
    readTools: [searchContacts],
    writeTools: [
      createContact,
      updateContact,
      createTask,
      createNote,
      // Both of these are dropped rather than offered-and-broken when the
      // portal cannot support them. See probeTicketsAvailable / fetchDealStages.
      ...(ticketsAvailable ? [createTicket] : []),
      ...dealTools,
    ],
  };
}
