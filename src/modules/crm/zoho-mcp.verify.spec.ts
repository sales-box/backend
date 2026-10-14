import {
  verifyZohoMcpServer,
  ZOHO_REQUIRED_TOOLS,
  explainConnectionFailure,
} from './zoho-mcp.verify';

const mockGetTools = jest.fn();

jest.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: jest.fn().mockImplementation(() => ({
    getTools: mockGetTools,
  })),
}));

beforeEach(() => jest.clearAllMocks());

describe('verifyZohoMcpServer', () => {
  it('accepts a server exposing all three primitives', async () => {
    mockGetTools.mockResolvedValue(
      ZOHO_REQUIRED_TOOLS.map((name) => ({ name })),
    );

    await expect(
      verifyZohoMcpServer('https://zoho/mcp'),
    ).resolves.toBeUndefined();
  });

  it('names the primitives a narrower server is missing', async () => {
    mockGetTools.mockResolvedValue([{ name: 'ZohoCRM_searchRecords' }]);

    await expect(verifyZohoMcpServer('https://zoho/mcp')).rejects.toThrow(
      /ZohoCRM_createRecords, ZohoCRM_updateRecords/,
    );
  });

  it('rejects an address with no MCP server behind it', async () => {
    mockGetTools.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      verifyZohoMcpServer('https://example.com/nope'),
    ).rejects.toThrow(/did not respond/i);
  });

  // A 401 means the URL was right and the server answered. Reporting it as a
  // bad address sent tenants off to re-copy a URL that had nothing wrong with
  // it — observed live against a Zoho registry server on 29 Aug.
  it('reports a rejected credential as authorisation, not a bad address', async () => {
    mockGetTools.mockRejectedValue(
      new Error(
        'Authentication failed for HTTP server "zoho". Check your credentials',
      ),
    );

    await expect(
      verifyZohoMcpServer(
        'https://zoho-crm-data-operations-1.zohomcp.com/mcp/x/message',
      ),
    ).rejects.toThrow(/401/);
  });

  it('never leaks the transport error into the message the tenant reads', async () => {
    // The MCP client embeds the whole HTTP response in its error. For a URL that
    // serves a web page that is the page's HTML, which once reached the UI as a
    // wall of markup with the useful sentence buried at the end.
    mockGetTools.mockRejectedValue(
      new Error(
        'Streamable HTTP error: Error POSTing to endpoint: <!doctype html><html>' +
          '<head><title>Example Domain</title></head><body><h1>Example Domain</h1>' +
          '</body></html> (SSE fallback failed: Non-200 status code (404))',
      ),
    );

    const err = await verifyZohoMcpServer('https://example.com/nope').catch(
      (e: Error) => e,
    );

    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).not.toMatch(/<[a-z!/]/i);
    expect(msg).not.toContain('example.com');
    expect(msg).not.toContain('Streamable HTTP');
    expect(msg).not.toContain('404');
    expect(msg.length).toBeLessThan(200);
  });
});

// Every failure used to collapse into "no server answered at that address",
// which sent a tenant off to re-copy a URL that was already correct. Observed
// live on 29 Aug: a Zoho registry server returns 401 to a URL that is exactly
// right, because those servers authorise through the agent platform.
describe('explainConnectionFailure', () => {
  it('names authorisation, not the address, on a 401', () => {
    const msg = explainConnectionFailure(
      'Authentication failed for HTTP server "zoho" at https://x.zohomcp.com/mcp/abc. Please check your credentials',
    );
    expect(msg).toMatch(/401/);
    expect(msg).toMatch(/authoris|authoriz/i);
    expect(msg).not.toMatch(/does not resolve|expire/i);
  });

  it('tells an expired URL apart from a rejected one', () => {
    const msg = explainConnectionFailure('getaddrinfo ENOTFOUND x.zohomcp.com');
    expect(msg).toMatch(/expire|does not resolve/i);
    expect(msg).not.toMatch(/401/);
  });

  it('names a timeout as a timeout', () => {
    expect(explainConnectionFailure('connect ETIMEDOUT 1.2.3.4:443')).toMatch(
      /did not respond/i,
    );
  });

  it('falls back to something actionable for an unrecognised failure', () => {
    const msg = explainConnectionFailure(
      'Streamable HTTP error: something odd',
    );
    expect(msg).toMatch(/exactly as Zoho generated it/i);
  });
});
