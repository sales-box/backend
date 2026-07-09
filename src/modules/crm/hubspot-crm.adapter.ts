import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AssociationTypes, Client } from '@hubspot/api-client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';
import { AssociationSpecAssociationCategoryEnum } from '@hubspot/api-client/lib/codegen/crm/objects/notes';
import { ClientRecord } from '../clients/clients.interface';
import { ICrmAdapter } from './crm.interface';

const CONTACT_PROPERTIES = ['email', 'firstname', 'lastname', 'company'];

@Injectable()
export class HubSpotAdapter implements ICrmAdapter {
  private readonly logger = new Logger(HubSpotAdapter.name);
  private readonly client: Client;

  constructor(config: ConfigService) {
    this.client = new Client({
      accessToken: config.getOrThrow<string>('HUBSPOT_API_KEY'),
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

  async logNote(contactId: string, note: string): Promise<void> {
    try {
      await this.client.crm.objects.notes.basicApi.create({
        properties: {
          hs_note_body: note,
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
      this.logger.error(`logNote failed for contact ${contactId}: ${msg}`);
      throw error;
    }
  }

  /** Returns the contact ID for an email, or null if none exists. */
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

  /** HubSpot stores firstname/lastname separately ,ClientRecord has one name. */
  private splitName(name: string | null): {
    firstName: string;
    lastName: string;
  } {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return { firstName: '', lastName: '' };
    const [firstName, ...rest] = trimmed.split(/\s+/);
    return { firstName, lastName: rest.join(' ') };
  }
}
