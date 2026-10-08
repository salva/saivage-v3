import { PassThrough } from 'node:stream';
import { describe, expect, it } from '@jest/globals';

import { discoverStdioTools, invokeStdioTool } from '../../src/mcp/stdio-transport.js';
import { mcpToolBinders } from '../../src/tools/mcp-provider.js';
import { invokeToolForLlm } from '../../src/tools/invocation.js';
import { testLlmToolInvocationContext, unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { canonicalJson } from '../../src/schemas/index.js';
import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';

async function composedStdioCall(content: unknown) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.once('data', (chunk) => {
    const request = JSON.parse(chunk.toString()) as { id: number | string };
    setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content } })}\n`));
  });
  const handle = { process: { stdin, stdout } } as any;
  const manager = {
    ...unusedMcpToolInvocation,
    invokeTool: () => invokeStdioTool({ serverName: 'server', toolName: 'tool', args: {}, handle, onResponse() {}, ids: { next: () => 3 }, signal: new AbortController().signal }),
    findToolCapability: () => null,
    getServerTools: () => undefined,
  };
  const surface = buildInvocationSurfaceFixture('executor', [bindToolProvider('mcp', mcpToolBinders, { projectRoot: '/unused', mcpToolInvocation: manager })]);
  const execution = await invokeToolForLlm(surface, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, testLlmToolInvocationContext({ sessionId: 'agent:executor:project', toolName: 'mcp_tool_call' }));
  return settleToolActionOutcome(execution.kind === 'executed' ? execution.execution.providerOutcome : execution.providerOutcome);
}

describe('stdio MCP transport composition', () => {
  it('answers negotiated workspace roots even when server request IDs collide with client IDs', async () => {
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const requests: any[] = []; let listId: number;
    stdin.on('data', bytes => {
      const message = JSON.parse(bytes.toString()); requests.push(message);
      if (message.method === 'initialize') {
        expect(message.params.capabilities).toEqual({ roots: { listChanged: false } });
        setImmediate(() => stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n'));
      } else if (message.method === 'tools/list') {
        listId = message.id;
        setImmediate(() => stdout.write(JSON.stringify({ jsonrpc: '2.0', id: listId, method: 'roots/list' }) + '\n'));
      } else if (message.result?.roots) {
        expect(message.result.roots).toEqual([{ uri: 'file:///project' }]);
        setImmediate(() => stdout.write(JSON.stringify({ jsonrpc: '2.0', id: listId, result: { tools: [{ name: 'capture', inputSchema: { type: 'object' } }] } }) + '\n'));
      }
    });
    let id = 0;
    expect(await discoverStdioTools({ serverName: 'browser', handle: { process: { stdin, stdout } as never }, ids: { next: () => ++id }, signal: new AbortController().signal, rootUri: 'file:///project' })).toMatchObject([{ name: 'capture' }]);
    expect(requests.some(message => message.result?.roots)).toBe(true);
    stdin.destroy(); stdout.destroy();
  });
  it('retains a small mapped result in the complete provider envelope', async () => {
    const content = [{ type: 'text', text: 'ok' }];
    await expect(composedStdioCall(content)).resolves.toMatchObject({
      providerResult: { success: true, content, data: { result: {} } },
    });
  });

  it('retains a complete large single-line response without truncation', async () => {
    const content = [{ type: 'text', text: 's'.repeat(60_000) }];
    const settled = await composedStdioCall(content);
    expect(settled.providerResult).toMatchObject({ success: true, content });
    expect(settled.settledResultBytes).toBe(canonicalJson(settled.providerResult));
    expect(Buffer.byteLength(settled.settledResultBytes, 'utf8')).toBeGreaterThan(32_768);
  });
});
