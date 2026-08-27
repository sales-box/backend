import { Logger } from '@nestjs/common';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { StructuredTool } from '@langchain/core/tools';
import type { CrmContact, ICrmAdapter } from './crm.interface';
import { extractRecords, toCrmContacts } from './zoho-records';

/**
 * The modules a contact can live in. Zoho splits people across two: a Lead is
 * an unqualified person, a Contact is one attached to an account. HubSpot has
 * one Contacts object, so importing only one Zoho module would silently hide
 * half the address book.
 */
const MODULES = ['Contacts', 'Leads'] as const;

/**
 * Listing every record is not one of the three primitives the connect flow
 * verifies, and Zoho MCP servers do not all name it the same way. Rather than
 * hardcode a guess, the adapter looks for one among the tools the server
 * actually exposes and falls back to a search that matches every row with an
 * email.
 */
const LISTER_PATTERN = /(?:get|list|fetch)Records$/i;

/** Matches every record that has an email — the only ones worth importing. */
const ALL_WITH_EMAIL = '(Email:not_equal:null)';

const MAX_PER_MODULE = 200;

export class ZohoMcpAdapter implements ICrmAdapter {
  private readonly logger = new Logger(ZohoMcpAdapter.name);
  private tools?: StructuredTool[];

  constructor(private readonly mcpServerUrl: string) {}

  private async getTools(): Promise<StructuredTool[]> {
    if (!this.tools) {
      const client = new MultiServerMCPClient({
        zoho: { transport: 'http', url: this.mcpServerUrl },
      });
      this.tools = await client.getTools();
    }
    return this.tools;
  }

  private async tool(name: string): Promise<StructuredTool | undefined> {
    return (await this.getTools()).find((t) => t.name === name);
  }

  private async lister(): Promise<StructuredTool | undefined> {
    const tools = await this.getTools();
    return tools.find(
      (t) => LISTER_PATTERN.test(t.name) && /zoho/i.test(t.name),
    );
  }

  /**
   * Confirms the credential can read. Contacts first, then Leads — a person
   * known to Zoho may be either.
   */
  async getContactByEmail(email: string): Promise<{ id: string } | null> {
    const search = await this.tool('ZohoCRM_searchRecords');
    if (!search) return null;

    for (const module of MODULES) {
      try {
        const raw: unknown = await search.invoke({
          path_variables: { module },
          query_params: { email },
        });
        const [first] = toCrmContacts(extractRecords(raw));
        if (first) return { id: first.crmId };
      } catch (error) {
        this.logger.warn(
          `Zoho ${module} lookup failed for ${email}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return null;
  }

  /**
   * Every person Zoho knows, across both modules, de-duplicated by email.
   *
   * A module that fails is logged and skipped rather than failing the whole
   * import: half an address book beats none, and the connect flow has already
   * proved the credential works.
   */
  async fetchContacts(): Promise<CrmContact[]> {
    const lister = await this.lister();
    const search = await this.tool('ZohoCRM_searchRecords');
    const reader = lister ?? search;

    if (!reader) {
      throw new Error(
        'the Zoho MCP server exposes no way to read records — regenerate the URL with read permission on Contacts and Leads',
      );
    }
    if (!lister) {
      this.logger.log(
        'No record-listing tool on this Zoho MCP server; falling back to a search for every row with an email',
      );
    }

    const byEmail = new Map<string, CrmContact>();

    for (const module of MODULES) {
      try {
        const raw: unknown = await reader.invoke({
          path_variables: { module },
          query_params: lister
            ? { per_page: MAX_PER_MODULE }
            : { criteria: ALL_WITH_EMAIL, per_page: MAX_PER_MODULE },
        });

        for (const contact of toCrmContacts(extractRecords(raw))) {
          // Contacts is read first, so an account-attached record wins over a
          // Lead row for the same person.
          const key = contact.email.toLowerCase();
          if (!byEmail.has(key)) byEmail.set(key, contact);
        }
      } catch (error) {
        this.logger.warn(
          `Zoho ${module} import failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return [...byEmail.values()];
  }
}
