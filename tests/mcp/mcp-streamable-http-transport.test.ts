import { describe, expect, it, jest } from '@jest/globals';
import { discoverStreamableHttpTools, invokeStreamableHttpTool, readStreamableHttpJsonRpcResponse } from '../../src/mcp/streamable-http-transport.js';

function sseData(payload: unknown): string { return `data: ${JSON.stringify(payload)}\n\n`; }
function sseResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(sseData(payload), { ...init, status: init.status ?? 200, headers: { 'content-type': 'text/event-stream', ...(init.headers as Record<string, string> | undefined) } });
}

describe('Streamable HTTP MCP transport', () => {
  it('reads matching JSON-RPC responses from SSE frames', async () => {
    const response = new Response(`: comment\n\ndata: {"jsonrpc":"2.0","id":99,"result":{}}\n\n${sseData({ jsonrpc: '2.0', id: 1, result: { ok: true } })}`, { headers: { 'content-type': 'text/event-stream' } });
    await expect(readStreamableHttpJsonRpcResponse(response, { serverName: 'srv', operation: 'op', expectedId: 1 })).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('propagates session ids through initialize, notification, paginated list, and invocation', async () => {
    let id = 1;
    const handle: { abortController: AbortController; streamableHttpSessionId?: string } = { abortController: new AbortController() };
    const calls: any[] = [];
    (globalThis as any).fetch = jest.fn(async (_url: string, init?: any) => {
      calls.push(init);
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') return sseResponse({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'Mcp-Session-Id': 'sess-1' } });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/list' && !body.params?.cursor) return sseResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'one', inputSchema: { type: 'object' } }], nextCursor: 'next' } });
      if (body.method === 'tools/list') return sseResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'two', inputSchema: { type: 'object' } }] } });
      return sseResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
    });

    const tools = await discoverStreamableHttpTools({ serverName: 'srv', config: { transport: 'sse', disabled: false, autostart: true, url: 'http://localhost/mcp' }, handle, ids: { next: () => id++ } });
    expect(tools.map((tool) => tool.name)).toEqual(['one', 'two']);
    expect(handle.streamableHttpSessionId).toBe('sess-1');
    const result = await invokeStreamableHttpTool({ serverName: 'srv', toolName: 'one', args: {}, config: { transport: 'sse', disabled: false, autostart: true, url: 'http://localhost/mcp' }, handle, timeoutMs: 1000, ids: { next: () => id++ } });
    expect(result).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.filter((call) => call.body && JSON.parse(call.body).method !== 'initialize').every((call) => call.headers['Mcp-Session-Id'] === 'sess-1')).toBe(true);
  });
});
