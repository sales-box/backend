import { verifyZohoMcpServer, ZOHO_REQUIRED_TOOLS } from './zoho-mcp.verify';

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
    ).rejects.toThrow(/no Zoho MCP server answered/);
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
