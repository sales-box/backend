import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AssociationTypes, Client } from '@hubspot/api-client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';
import { FilterOperatorEnum as DealFilterEnum } from '@hubspot/api-client/lib/codegen/crm/deals';
import { AssociationSpecAssociationCategoryEnum } from '@hubspot/api-client/lib/codegen/crm/objects/notes';
import { ClientRecord } from '../clients/clients.interface';
import type { ICrmAdapter, NotePayload } from './crm.interface';

const CONTACT_PROPERTIES = ['email', 'firstname', 'lastname', 'company'];

const STAGE_MAP: Record<string, string> = {
  product_inquiry: 'presentationscheduled',
  meeting_request: 'appointmentscheduled',
};

@Injectable()
export class HubSpotAdapter implements ICrmAdapter {
  private readonly logger = new Logger(HubSpotAdapter.name);
  private readonly client: Client;

  constructor(configOrApiKey: ConfigService | string) {
    const accessToken =
      typeof configOrApiKey === 'string'
        ? configOrApiKey
        : configOrApiKey.getOrThrow<string>('HUBSPOT_API_KEY');
    this.client = new Client({
      accessToken,
    });
  }

  async syncContact(client: ClientRecord): Promise<string> {
    try {
      const { firstName, lastName } = this.splitName(client.name);
      const properties: Record<string, string> = {
        email: client.email,
        firstname: firstName,
        lastname: lastName,
      };
      if (client.company) properties.company = client.company;

      const existingId = await this.findContactIdByEmail(client.email);

      if (existingId) {
        await this.client.crm.contacts.basicApi.update(existingId, {
          properties,
        });
        this.logger.log(
          `Updated HubSpot contact ${existingId} (${client.email})`,
        );
        return existingId;
      }

      const created = await this.client.crm.contacts.basicApi.create({
        properties,
        associations: [],
      });
      this.logger.log(
        `Created HubSpot contact ${created.id} (${client.email})`,
      );
      return created.id;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`syncContact failed for ${client.email}: ${msg}`);
      throw error;
    }
  }

  async createOrUpdateDeal(
    contactId: string,
    classification: string,
    subject: string,
    company: string,
  ): Promise<string> {
    try {
      const dealName = `${company || 'Unknown'} — ${subject}`;
      const stage = STAGE_MAP[classification] ?? 'qualifiedtobuy';

      const existingDealId = await this.findDealByName(dealName);

      if (existingDealId) {
        await this.client.crm.deals.basicApi.update(existingDealId, {
          properties: { dealstage: stage },
        });
        this.logger.log(
          `Updated HubSpot deal ${existingDealId} stage → ${stage}`,
        );
        return existingDealId;
      }

      const created = await this.client.crm.deals.basicApi.create({
        properties: {
          dealname: dealName,
          dealstage: stage,
          pipeline: 'default',
        },
        associations: [
          {
            to: { id: contactId },
            types: [
              {
                associationCategory:
                  AssociationSpecAssociationCategoryEnum.HubspotDefined,
                associationTypeId: AssociationTypes.dealToContact,
              },
            ],
          },
        ],
      });
      this.logger.log(`Created HubSpot deal ${created.id} ("${dealName}")`);
      return created.id;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `createOrUpdateDeal failed for contact ${contactId}: ${msg}`,
      );
      throw error;
    }
  }

  async logEngagementNote(contactId: string, note: NotePayload): Promise<void> {
    try {
      const body = [
        `Subject: ${note.subject}`,
        `Classification: ${note.classification}`,
        `Summary: ${note.summary}`,
        `Sent at: ${note.sentAt}`,
      ].join('\n');

      await this.client.crm.objects.notes.basicApi.create({
        properties: {
          hs_note_body: body,
          hs_timestamp: new Date().toISOString(),
        },
        associations: [
          {
            to: { id: contactId },
            types: [
              {
                associationCategory:
                  AssociationSpecAssociationCategoryEnum.HubspotDefined,
                associationTypeId: AssociationTypes.noteToContact,
              },
            ],
          },
        ],
      });
      this.logger.log(`Logged note on HubSpot contact ${contactId}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `logEngagementNote failed for contact ${contactId}: ${msg}`,
      );
      throw error;
    }
  }

  private async findDealByName(dealName: string): Promise<string | null> {
    const result = await this.client.crm.deals.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'dealname',
              operator: DealFilterEnum.Eq,
              value: dealName,
            },
          ],
        },
      ],
      properties: ['dealname', 'dealstage'],
      limit: 1,
      after: '0',
      sorts: [],
    });

    return result.results[0]?.id ?? null;
  }

  private async findContactIdByEmail(email: string): Promise<string | null> {
    const result = await this.client.crm.contacts.searchApi.doSearch({
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
      properties: CONTACT_PROPERTIES,
      limit: 1,
      after: '0',
      sorts: [],
    });

    return result.results[0]?.id ?? null;
  }

  private splitName(name: string | null): {
    firstName: string;
    lastName: string;
  } {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return { firstName: '', lastName: '' };
    const [firstName, ...rest] = trimmed.split(/\s+/);
    return { firstName, lastName: rest.join(' ') };
  }

  async getContactByEmail(email: string): Promise<{ id: string } | null> {
    try {
      const id = await this.findContactIdByEmail(email);
      return id ? { id } : null;
    } catch (error) {
      this.logger.error(
        `getContactByEmail failed for ${email}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  async fetchContacts(): Promise<
    Array<{
      email: string;
      name?: string;
      company?: string;
      crmId: string;
    }>
  > {
    try {
      const response = await this.client.crm.contacts.basicApi.getPage(
        100,
        undefined,
        CONTACT_PROPERTIES,
      );
      return response.results
        .map((contact) => {
          const email = contact.properties.email;
          const firstname = contact.properties.firstname || '';
          const lastname = contact.properties.lastname || '';
          const company = contact.properties.company || undefined;
          const name =
            [firstname, lastname].filter(Boolean).join(' ') || undefined;
          return {
            email,
            name,
            company,
            crmId: contact.id,
          };
        })
        .filter(
          (
            c,
          ): c is {
            email: string;
            name: string | undefined;
            company: string | undefined;
            crmId: string;
          } => !!c.email,
        );
    } catch (error) {
      this.logger.error(
        `fetchContacts failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }
}
