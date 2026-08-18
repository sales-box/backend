import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@hubspot/api-client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';
import type { ICrmAdapter } from './crm.interface';

const CONTACT_PROPERTIES = ['email', 'firstname', 'lastname', 'company'];

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
