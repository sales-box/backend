import { MultiServerMCPClient } from '@langchain/mcp-adapters';

/**
 * The three primitives every CRM tool for Zoho is built from.
 *
 * Declared here rather than inside the agent factory so the connect flow can
 * check for exactly what the agent will later demand. If these two lists drift,
 * a tenant connects successfully and then discovers at reply time that the
 * agent cannot act — which is the failure this file exists to prevent.
 */
export const ZOHO_REQUIRED_TOOLS = [
  'ZohoCRM_searchRecords',
  'ZohoCRM_createRecords',
  'ZohoCRM_updateRecords',
] as const;

/**
 * Prove a Zoho MCP URL is usable before telling the tenant it is connected.
 *
 * Resolves when the server answers and exposes all three primitives. Rejects
 * with a message the tenant can act on otherwise: a typo'd URL, an expired
 * presigned link, and a server that is up but exposes a narrower toolset are
 * three different problems with three different fixes.
 */
export async function verifyZohoMcpServer(mcpServerUrl: string): Promise<void> {
  let toolNames: string[];

  try {
    const client = new MultiServerMCPClient({
      zoho: { transport: 'http', url: mcpServerUrl },
    });
    const tools = await client.getTools();
    toolNames = tools.map((t) => t.name);
  } catch (error) {
    throw new Error(
      `could not reach the Zoho MCP server — ${
        error instanceof Error ? error.message : String(error)
      }. Check the URL is the presigned one Zoho gave you and that it has not expired.`,
    );
  }

  const missing = ZOHO_REQUIRED_TOOLS.filter((n) => !toolNames.includes(n));

  if (missing.length > 0) {
    throw new Error(
      `the server answered but does not expose ${missing.join(', ')}. ` +
        'Regenerate the MCP URL with search, create and update permissions on your Zoho modules.',
    );
  }
}
