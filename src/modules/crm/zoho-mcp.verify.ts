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
 * Turn the MCP client's transport error into the one sentence that helps.
 *
 * Every failure used to collapse into "no server answered at that address",
 * which sent a tenant off to re-copy a URL that was already correct. The three
 * real causes need three different actions, and a 401 in particular is not a
 * bad address at all — the server answered and refused.
 */
export function explainConnectionFailure(raw: string): string {
  if (
    /\b401\b|unautheni?ticated|authentication failed|unauthorized/i.test(raw)
  ) {
    return (
      'Zoho rejected the credential (401). The server is reachable, so the URL ' +
      'is right — it has not been authorised for this workspace. Zoho\u2019s ' +
      'registry servers (Data Operations and the rest) authorise through the ' +
      'agent platform rather than the URL, so they cannot be connected here; ' +
      'use a presigned MCP URL whose token carries its own access.'
    );
  }

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|NXDOMAIN/i.test(raw)) {
    return (
      'that address does not resolve. Presigned Zoho MCP URLs expire — ' +
      'generate a fresh one if yours is old, and check the whole URL was ' +
      'copied.'
    );
  }

  if (/ETIMEDOUT|timeout|timed out|ECONNREFUSED/i.test(raw)) {
    return (
      'the Zoho MCP server did not respond in time. It may be down, or the ' +
      'URL may point at something that is not an MCP endpoint.'
    );
  }

  return (
    'could not open an MCP session at that address. Paste the presigned URL ' +
    'exactly as Zoho generated it, including the path after the host.'
  );
}

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
    const raw = error instanceof Error ? error.message : String(error);
    logger.warn(`Zoho MCP verification failed for ${mcpServerUrl}: ${raw}`);
    throw new Error(explainConnectionFailure(raw));
  }

  const missing = ZOHO_REQUIRED_TOOLS.filter((n) => !toolNames.includes(n));

  if (missing.length > 0) {
    throw new Error(
      `the server answered but does not expose ${missing.join(', ')}. ` +
        'Regenerate the MCP URL with search, create and update permissions on your Zoho modules.',
    );
  }
}
