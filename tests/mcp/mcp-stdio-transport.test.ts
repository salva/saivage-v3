import { PassThrough } from 'node:stream';
import { describe, expect, it } from '@jest/globals';

import { invokeStdioTool } from '../../src/mcp/stdio-transport.js';
import { mcpToolBinders } from '../../src/tools/mcp-provider.js';
import { invokeTool } from '../../src/tools/invocation.js';
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
    invokeTool: () => invokeStdioTool({ serverName: 'server', toolName: 'tool', args: {}, handle, timeoutMs: 1_000, ids: { next: () => 3 }, signal: new AbortController().signal }),
    findToolCapability: () => null,
    getServerTools: () => undefined,
  };
  const surface = buildInvocationSurfaceFixture('executor', [bindToolProvider('mcp', mcpToolBinders, { mcpToolInvocation: manager })]);
  const execution = await invokeTool(surface, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' });
  return settleToolActionOutcome(execution.providerOutcome);
}

describe('stdio MCP transport composition', () => {
  it('retains a small mapped result in the complete provider envelope', async () => {
    const content = [{ type: 'text', text: 'ok' }];
    await expect(composedStdioCall(content)).resolves.toMatchObject({
      providerResult: { success: true, data: { result: content, result_complete: true, result_utf8_bytes: Buffer.byteLength(canonicalJson(content), 'utf8') } },
    });
  });

  it('settles an oversized single-line response as an exact bounded incomplete result', async () => {
    const content = [{ type: 'text', text: 's'.repeat(60_000) }];
    const source = canonicalJson(content);
    const settled = await composedStdioCall(content);
    const data = (settled.providerResult as any).data;
    expect(data).toMatchObject({ result_complete: false, result_utf8_bytes: Buffer.byteLength(source, 'utf8') });
    expect(source.startsWith(data.result)).toBe(true);
    expect(data.result).toBe('[{');
    expect(settled.settledResultBytes).toBe(canonicalJson(settled.providerResult));
    expect(Buffer.byteLength(settled.settledResultBytes, 'utf8')).toBeLessThanOrEqual(32_768);
  });
});
