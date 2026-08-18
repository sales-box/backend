import { Logger } from '@nestjs/common';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';

const logger = new Logger('ZohoMcpVerify');

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
    // The raw failure is worth keeping, but not worth showing. The MCP client
    // reports a transport error that embeds the entire HTTP response — for a
    // URL that answers with a web page, that is the page's HTML. Pasting that
    // into a toast tells the tenant nothing and buries the one sentence that
    // would help. It goes to the log; they get the sentence.
    logger.warn(
      `Zoho MCP verification failed for ${mcpServerUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    throw new Error(
      'no Zoho MCP server answered at that address. ' +
        'Paste the presigned URL exactly as Zoho generated it — these expire, ' +
        'so generate a fresh one if yours is old.',
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
