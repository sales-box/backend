import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@hubspot/api-client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';
import type { CrmContact, ICrmAdapter } from './crm.interface';
import { statusFromLifecycleStage } from './hubspot-lifecycle';

// lifecyclestage is what separates a cold lead from a paying customer. Without
// it every imported contact arrived identical, so the local status column was
// dead on arrival.
const CONTACT_PROPERTIES = [
  'email',
  'firstname',
  'lastname',
  'company',
  'lifecyclestage',
];

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

  async fetchContacts(): Promise<CrmContact[]> {
    try {
      const response = await this.client.crm.contacts.basicApi.getPage(
        100,
        undefined,
        CONTACT_PROPERTIES,
      );
      // flatMap rather than map+filter: dropping the contact inside the
      // callback narrows email to string, so the row is built once and needs
      // no cast to satisfy CrmContact.
      return response.results.flatMap<CrmContact>((contact) => {
        const email = contact.properties.email;
        if (!email) return [];
        const firstname = contact.properties.firstname || '';
        const lastname = contact.properties.lastname || '';
        const company = contact.properties.company || undefined;
        const name =
          [firstname, lastname].filter(Boolean).join(' ') || undefined;
        return [
          {
            email,
            name,
            company,
            crmId: contact.id,
            status: statusFromLifecycleStage(contact.properties.lifecyclestage),
          },
        ];
      });
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
