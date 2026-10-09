import { PassThrough } from 'node:stream';
import { describe, expect, it } from '@jest/globals';

import { StdioMcpConnection } from '../../src/mcp/stdio-transport.js';
import { TransportError } from '../../src/mcp/errors.js';
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
  const connection = new StdioMcpConnection({ serverName: 'server', stdin, stdout, ids: { next: () => 3 }, onFailure() {} });
  const manager = {
    ...unusedMcpToolInvocation,
    invokeTool: () => connection.invoke({ toolName: 'tool', args: {}, onResponse() {}, signal: new AbortController().signal }),
    findToolCapability: () => null,
    getServerTools: () => undefined,
  };
  const surface = buildInvocationSurfaceFixture('executor', [bindToolProvider('mcp', mcpToolBinders, { projectRoot: '/unused', mcpToolInvocation: manager })]);
  const execution = await invokeToolForLlm(surface, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, testLlmToolInvocationContext({ sessionId: 'agent:executor:project', toolName: 'mcp_tool_call' }));
  connection.dispose(new Error('test complete')); stdin.destroy(); stdout.destroy();
  return settleToolActionOutcome(execution.kind === 'executed' ? execution.execution.providerOutcome : execution.providerOutcome);
}

describe('stdio MCP transport composition', () => {
  it.each(['same chunk', 'idle'] as const)(
    'answers roots after discovery response (%s)',
    async (timing) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const answers: unknown[] = [];
      let id = 0;
      const roots =
        JSON.stringify({ jsonrpc: '2.0', id: 'workspace', method: 'roots/list' }) + '\n';
      const connection = new StdioMcpConnection({
        serverName: 'one',
        stdin,
        stdout,
        ids: { next: () => ++id },
        rootUri: 'file:///project',
        onFailure() {},
      });
      stdin.on('data', (bytes) => {
        const message = JSON.parse(bytes.toString());
        if (message.result?.roots) answers.push(message);
        if (message.method === 'initialize' || message.method === 'tools/list') {
          setImmediate(() =>
            stdout.write(
              JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }) +
                '\n' +
                (message.method === 'tools/list' && timing === 'same chunk' ? roots : ''),
            ),
          );
        }
      });
      try {
        await connection.discover(new AbortController().signal);
        if (timing === 'idle')
          await new Promise<void>((resolve) =>
            setImmediate(() => {
              stdout.write(roots);
              resolve();
            }),
          );
        expect(answers).toEqual([
          { jsonrpc: '2.0', id: 'workspace', result: { roots: [{ uri: 'file:///project' }] } },
        ]);
      } finally {
        connection.dispose(new Error('test complete'));
        stdin.destroy();
        stdout.destroy();
      }
    },
  );
  it.each(['initialize', 'tools/list'] as const)('classifies %s rejection/closure without exporting remote text', async stage => {
    for (const close of [false, true]) {
      const stdin = new PassThrough(); const stdout = new PassThrough();
      const methods: string[] = [];
      stdin.on('data', bytes => {
        const request = JSON.parse(bytes.toString()); methods.push(request.method);
        if (request.method === 'notifications/initialized') return;
        setImmediate(() => {
          if (request.method === stage && close) stdout.end();
          else stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(request.method === stage ? { error: { code: -32001, message: 'secret-remote-message' } } : { result: {} }) }) + '\n');
        });
      });
      let id = 0;
      const connection = new StdioMcpConnection({ serverName: 'one', stdin, stdout, ids: { next: () => ++id }, onFailure() {} });
      try {
        const error = await connection.discover(new AbortController().signal).catch(error => error);
        expect(error).toBeInstanceOf(TransportError);
        expect(error.message).toContain(stage);
        expect(error.message).toContain(close ? 'stream closed before response' : 'code -32001');
        expect(error.message).not.toContain('secret-remote-message');
        expect(methods).toEqual(stage === 'initialize' ? ['initialize'] : ['initialize', 'notifications/initialized', 'tools/list']);
      } finally { connection.dispose(new Error('test complete')); stdin.destroy(); stdout.destroy(); }
    }
  });
  it('leaves ID-source invariants unclassified', async () => {
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const failure = new Error('ID invariant');
    const connection = new StdioMcpConnection({ serverName: 'one', stdin, stdout, ids: { next: () => { throw failure; } }, onFailure() {} });
    try {
      await expect(connection.discover(new AbortController().signal)).rejects.toBe(failure);
    } finally { connection.dispose(new Error('test complete')); stdin.destroy(); stdout.destroy(); }
  });
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
    const connection = new StdioMcpConnection({ serverName: 'browser', stdin, stdout, ids: { next: () => ++id }, rootUri: 'file:///project', onFailure() {} });
    expect(await connection.discover(new AbortController().signal)).toMatchObject([{ name: 'capture' }]);
    expect(requests.some(message => message.result?.roots)).toBe(true);
    connection.dispose(new Error('test complete')); stdin.destroy(); stdout.destroy();
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
