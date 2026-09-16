import { describe, expect, it, jest } from '@jest/globals';

import { invokeTool } from '../../src/tools/invocation.js';
import { mcpToolBinders, type McpProviderContext } from '../../src/tools/mcp-provider.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { canonicalJson } from '../../src/schemas/index.js';
import { projectDynamicForOutbound } from '../../src/redaction/dynamic.js';
import { invokeStreamableHttpTool } from '../../src/mcp/streamable-http-transport.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';

const provider = (context: McpProviderContext) => bindToolProvider('mcp', mcpToolBinders, context);

async function invoke(value: unknown) {
  const manager = { invokeTool: jest.fn(async () => value), findToolCapability: jest.fn(() => null), getServerTools: jest.fn(() => undefined) };
  const surface = buildInvocationSurfaceFixture('executor', [provider({ mcpToolInvocation: manager })]);
  const execution = await invokeTool(surface, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' });
  return settleToolActionOutcome(execution.providerOutcome);
}

describe('MCP provider result settlement envelope', () => {
  it.each([
    [{ value: 1 }],
    ['scalar'],
    [false],
  ])('preserves a complete projected result and reports its canonical source bytes', async (value) => {
    const settled = await invoke(value);
    const projected = projectDynamicForOutbound(value);
    expect(settled.providerResult).toEqual({
      success: true,
      data: { result: projected, result_complete: true, result_utf8_bytes: Buffer.byteLength(canonicalJson(projected), 'utf8') },
    });
    expect(settled.settledResultBytes).toBe(canonicalJson(settled.providerResult));
    expect(Buffer.byteLength(settled.settledResultBytes, 'utf8')).toBeLessThanOrEqual(32_768);
  });

  it('returns the largest fitting exact UTF-8 prefix for an oversized multibyte result', async () => {
    const value = 'é'.repeat(30_000);
    const source = canonicalJson(projectDynamicForOutbound(value));
    const settled = await invoke(value);
    const data = (settled.providerResult as any).data;
    expect(data.result_complete).toBe(false);
    expect(data.result_utf8_bytes).toBe(Buffer.byteLength(source, 'utf8'));
    expect(source.startsWith(data.result)).toBe(true);
    expect(settled.settledResultBytes).toBe(canonicalJson(settled.providerResult));
    expect(Buffer.byteLength(settled.settledResultBytes, 'utf8')).toBeLessThanOrEqual(32_768);
    expect(data.result.endsWith('\ud83d')).toBe(false);
    const nextCharacter = Array.from(source.slice(data.result.length))[0];
    expect(nextCharacter).toBeDefined();
    const next = { result: data.result + nextCharacter, result_complete: false, result_utf8_bytes: data.result_utf8_bytes };
    expect(Buffer.byteLength(canonicalJson({ success: true, data: next }), 'utf8')).toBeGreaterThan(32_768);
  });

  it('retreats from a credential placeholder boundary and remains projection-idempotent', async () => {
    const rawSecret = `sk-${'x'.repeat(200)}`;
    const value = `${'a'.repeat(32_674)} ${rawSecret} ${'b'.repeat(20_000)}`;
    const source = canonicalJson(projectDynamicForOutbound(value));
    const settled = await invoke(value);
    const data = (settled.providerResult as any).data;
    expect(data.result_complete).toBe(false);
    expect(source.startsWith(data.result)).toBe(true);
    expect(data.result).toBe(source.slice(0, source.indexOf('sk-[REDACTED]')));
    expect(data.result).not.toContain(rawSecret);
    expect(projectDynamicForOutbound(data.result)).toBe(data.result);
    expect(data.result).not.toMatch(/sk-\[REDAC?$/u);
    expect(settled.settledResultBytes).toBe(canonicalJson(settled.providerResult));
  });

  it('uses only the common original canonical prefix when text projection changes a serialized key', async () => {
    const secretKey = `sk-${'q'.repeat(80)}`;
    const value = { [secretKey]: 'ordinary', trailing: 'x'.repeat(40_000) };
    const source = canonicalJson(projectDynamicForOutbound(value));
    const settled = await invoke(value);
    const data = (settled.providerResult as any).data;
    expect(data.result_complete).toBe(false);
    expect(data.result).toBe('{');
    expect(source.startsWith(data.result)).toBe(true);
    expect(data.result).not.toContain(secretKey);
    expect(projectDynamicForOutbound(data.result)).toBe(data.result);
  });

  it('bounds an expansion-heavy multibyte error without cutting a redaction span', async () => {
    const message = `${'é'.repeat(220)} ${'sk-x '.repeat(100)}`;
    const manager = { invokeTool: async () => { throw new Error(message); }, findToolCapability: () => null, getServerTools: () => undefined };
    const surface = buildInvocationSurfaceFixture('executor', [provider({ mcpToolInvocation: manager })]);
    const execution = await invokeTool(surface, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' });
    const settled = settleToolActionOutcome(execution.providerOutcome);
    const result = settled.providerResult;
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected MCP failure.');
    expect(result.error).toBe(`${'é'.repeat(220)} ${'sk-[REDACTED] '.repeat(5)}`);
    expect(Buffer.byteLength(result.error, 'utf8')).toBe(511);
    expect(result.error).not.toContain('sk-x');
    expect(projectDynamicForOutbound(result.error)).toBe(result.error);
    expect(result.error).not.toMatch(/sk-\[REDAC?$/u);
    expect(settled.settledResultBytes).toBe(canonicalJson(result));
  });

  it('keeps ordinary short invocation errors unchanged', async () => {
    const manager = { invokeTool: async () => { throw new Error('transport failed'); }, findToolCapability: () => null, getServerTools: () => undefined };
    const surface = buildInvocationSurfaceFixture('executor', [provider({ mcpToolInvocation: manager })]);
    const execution = await invokeTool(surface, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' });
    expect(settleToolActionOutcome(execution.providerOutcome).providerResult).toEqual({ success: false, error: 'transport failed' });
  });

  it('propagates packing failures after a successful invocation', async () => {
    const value = new Proxy({}, { ownKeys: () => { throw new Error('projection failed'); } });
    const manager = { invokeTool: jest.fn(async () => value), findToolCapability: () => null, getServerTools: () => undefined };
    const surface = buildInvocationSurfaceFixture('executor', [provider({ mcpToolInvocation: manager })]);
    await expect(invokeTool(surface, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' })).rejects.toThrow('projection failed');
    expect(manager.invokeTool).toHaveBeenCalledTimes(1);
  });

  it('preserves publication-unknown invocation failures as fatal', async () => {
    const failure = new PublicationOutcomeUnknownError();
    const manager = { invokeTool: async () => { throw failure; }, findToolCapability: () => null, getServerTools: () => undefined };
    const surface = buildInvocationSurfaceFixture('executor', [provider({ mcpToolInvocation: manager })]);
    await expect(invokeTool(surface, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' })).rejects.toBe(failure);
  });

  it('composes an oversized HTTP JSON result through transport mapping and final settlement', async () => {
    const nativeFetch = globalThis.fetch;
    const content = [{ type: 'text', text: 'h'.repeat(60_000) }];
    globalThis.fetch = jest.fn(async (...args: Parameters<typeof fetch>) => {
      const init = args[1];
      const id = JSON.parse(String(init?.body)).id;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { content } }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const manager = {
        invokeTool: (_serverName: string, _toolName: string, _args: Record<string, unknown>) => invokeStreamableHttpTool({
          serverName: 'server', toolName: 'tool', args: {}, config: { transport: 'streamable-http', disabled: false, autostart: true, url: 'http://localhost/mcp' },
          timeoutMs: 1_000, ids: { next: () => 7 }, signal: new AbortController().signal,
        }),
        findToolCapability: () => null,
        getServerTools: () => undefined,
      };
      const surface = buildInvocationSurfaceFixture('executor', [provider({ mcpToolInvocation: manager })]);
      const execution = await invokeTool(surface, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' });
      const settled = settleToolActionOutcome(execution.providerOutcome);
      expect(settled.providerResult).toMatchObject({ success: true, data: { result_complete: false, result_utf8_bytes: Buffer.byteLength(canonicalJson(content), 'utf8') } });
      expect(settled.settledResultBytes).toBe(canonicalJson(settled.providerResult));
      expect(Buffer.byteLength(settled.settledResultBytes, 'utf8')).toBeLessThanOrEqual(32_768);
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });
});
