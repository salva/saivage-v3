import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as YAML from 'yaml';
import { InvalidArgumentsError, McpInvokeError, McpManager, ServerNotRunningError, TimeoutError, ToolNotFoundError, TransportError } from '../../src/mcp/mcp-manager.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { testConfigAuthority } from '../helpers/canonical-project.js';

const roots: string[] = [];
const managers: McpManager[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'mcp-invoke-'));
  roots.push(value);
  return value;
}

function writeConfig(projectRoot: string, mcpServers: Record<string, unknown>): void {
  mkdirSync(join(projectRoot, '.saivage'), { recursive: true });
  writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), YAML.stringify({
    models: { default: ['test-model'] }, providers: { test: { models: ['test-model'] } }, compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'test', account: null, model: 'test-model' } }, server: { host: '127.0.0.1', port: 8080 }, mcpServers,
  }));
}

function manager(projectRoot: string): McpManager {
  const value = new McpManager({ configAuthority: testConfigAuthority(projectRoot), processRunner: new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()) });
  managers.push(value);
  return value;
}

function response(id: number, result: Record<string, unknown>): Response {
  return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

function httpFetch(toolResult: unknown = [{ type: 'text', text: 'pong' }]) {
  return jest.fn(async (_url: string | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 200 });
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'initialize') return response(request.id, { protocolVersion: '2025-06-18' });
    if (request.method === 'tools/list') return response(request.id, { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }] });
    return response(request.id, { content: toolResult });
  });
}

function stdioScript(): string {
  return `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18' } }) + '\\n');
  if (request.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] } }) + '\\n');
  if (request.method === 'tools/call') setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [request.params.arguments.value] } }) + '\\n'), request.params.arguments.value === 'first' ? 50 : 0);
});`;
}

afterEach(async () => {
  for (const value of managers.splice(0)) await value.cleanupForApplicationStop().catch(() => undefined);
  jest.restoreAllMocks();
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('MCP invocation errors', () => {
  it('retains typed public errors', () => {
    expect(new ServerNotRunningError('s')).toMatchObject({ code: 'SERVER_NOT_RUNNING', statusCode: 404 });
    expect(new ToolNotFoundError('s', 't')).toMatchObject({ code: 'TOOL_NOT_FOUND', statusCode: 404 });
    expect(new InvalidArgumentsError('s', 't')).toMatchObject({ code: 'INVALID_ARGUMENTS', statusCode: 400 });
    expect(new TimeoutError('s', 't', 10)).toMatchObject({ code: 'TIMEOUT', statusCode: 408 });
    expect(new TransportError('s', 'x')).toMatchObject({ code: 'TRANSPORT_ERROR', statusCode: 502 });
    expect(new ServerNotRunningError('s')).toBeInstanceOf(McpInvokeError);
  });

  it('rejects invocation when no active runtime exists', async () => {
    const projectRoot = root();
    writeConfig(projectRoot, {});
    await expect(manager(projectRoot).invokeTool('missing', 'ping', {})).rejects.toBeInstanceOf(ServerNotRunningError);
  });
});

describe('contained MCP invocation', () => {
  it('discovers and invokes Streamable HTTP tools while recording statistics', async () => {
    const projectRoot = root();
    writeConfig(projectRoot, { web: { transport: 'streamable-http', url: 'http://localhost/mcp', autostart: true } });
    globalThis.fetch = httpFetch() as typeof fetch;
    const mcp = manager(projectRoot);
    expect((await mcp.reconcilePersistedConfig()).converged).toBe(true);

    await expect(mcp.invokeTool('web', 'ping', { count: 1 })).resolves.toEqual([{ type: 'text', text: 'pong' }]);
    expect(mcp.getInvocationStats()['web:ping']).toMatchObject({ total: 1, success: 1, error: 0 });
  });

  it('validates discovered input schemas before transport work and keeps diagnostics secret-free', async () => {
    const projectRoot = root();
    writeConfig(projectRoot, { web: { transport: 'streamable-http', url: 'http://localhost/mcp', autostart: true } });
    const fetchMock = httpFetch();
    globalThis.fetch = fetchMock as typeof fetch;
    const mcp = manager(projectRoot);
    await mcp.reconcilePersistedConfig();
    const callsBefore = fetchMock.mock.calls.length;
    const secret = 'synthetic-secret-that-must-not-appear';

    await expect(mcp.invokeTool('web', 'ping', { count: secret, [secret]: true })).rejects.toBeInstanceOf(InvalidArgumentsError);
    expect(fetchMock).toHaveBeenCalledTimes(callsBefore);
    try { await mcp.invokeTool('web', 'ping', { count: secret, [secret]: true }); }
    catch (error) { expect(JSON.stringify(error)).not.toContain(secret); }
    expect(mcp.getInvocationStats()).toEqual({});
  });

  it('allows concurrent HTTP invocation operations', async () => {
    const projectRoot = root();
    writeConfig(projectRoot, { web: { transport: 'streamable-http', url: 'http://localhost/mcp', autostart: true } });
    let concurrent = 0;
    let maximum = 0;
    const base = httpFetch();
    globalThis.fetch = jest.fn(async (url: string | URL, init?: RequestInit) => {
      const request = init?.body ? JSON.parse(String(init.body)) as { method: string } : undefined;
      if (request?.method === 'tools/call') {
        concurrent += 1;
        maximum = Math.max(maximum, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 30));
        concurrent -= 1;
      }
      return base(url, init);
    }) as typeof fetch;
    const mcp = manager(projectRoot);
    await mcp.reconcilePersistedConfig();

    await Promise.all([mcp.invokeTool('web', 'ping', { count: 1 }), mcp.invokeTool('web', 'ping', { count: 2 })]);
    expect(maximum).toBe(2);
  });

  it('serializes stdio calls on the contained server process', async () => {
    const projectRoot = root();
    const script = join(projectRoot, 'server.cjs');
    writeFileSync(script, stdioScript());
    writeConfig(projectRoot, { local: { transport: 'stdio', command: process.execPath, args: [script], autostart: true } });
    const mcp = manager(projectRoot);
    expect((await mcp.reconcilePersistedConfig()).converged).toBe(true);

    const results = await Promise.all([
      mcp.invokeTool('local', 'echo', { value: 'first' }),
      mcp.invokeTool('local', 'echo', { value: 'second' }),
    ]);
    expect(results).toEqual([['first'], ['second']]);
  });

  it('drains high-volume stdio server stderr before protocol responses', async () => {
    const projectRoot = root();
    const script = join(projectRoot, 'noisy-server.cjs');
    writeFileSync(script, `
const readline = require('node:readline');
const { once } = require('node:events');
const rl = readline.createInterface({ input: process.stdin });
const stderrChunk = Buffer.alloc(64 * 1024, 'x');
async function writeStderr() {
  for (let written = 0; written < 8 * 1024 * 1024; written += stderrChunk.length) {
    if (!process.stderr.write(stderrChunk)) await once(process.stderr, 'drain');
  }
}
rl.on('line', async (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18' } }) + '\\n');
  if (request.method === 'tools/list') {
    await writeStderr();
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] } }) + '\\n');
  }
  if (request.method === 'tools/call') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'echo:' + request.params.arguments.value }] } }) + '\\n');
});`);
    writeConfig(projectRoot, { local: { transport: 'stdio', command: process.execPath, args: [script], autostart: true } });
    const mcp = manager(projectRoot);

    expect((await mcp.reconcilePersistedConfig()).converged).toBe(true);
    await expect(mcp.invokeTool('local', 'echo', { value: 'complete' })).resolves.toEqual([
      { type: 'text', text: 'echo:complete' },
    ]);
  });
});
