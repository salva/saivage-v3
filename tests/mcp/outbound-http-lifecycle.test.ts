import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import { createMcpToolInvocationInstallation } from '../../src/mcp/tool-invocation-installation.js';
import { invokeStreamableHttpTool } from '../../src/mcp/streamable-http-transport.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { BoundAgentToolSet, resolveRuntimeTool } from '../../src/tools/runtime-tool-catalog.js';
import { invokeToolForLlm } from '../../src/tools/invocation.js';
import { projectOutboundSource } from '../../src/observability/index.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { testConfigAuthority } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';
import { capturedHttp, deferred, microtasks, assertPrivateMetadata, assertLifecycles } from '../helpers/http-lifecycle.js';
import { controlledResponse, pendingHeaders } from '../helpers/provider-inactivity.js';

const config = { transport: 'streamable-http' as const, url: 'https://secret-host.invalid/secret-path?secret-query#secret-fragment', autostart: false, disabled: false };
const roots: string[] = [];
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function rpc(id: number, result: unknown, sse = false) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
  const response = new Response(sse ? `data: ${payload}\n\n` : payload, { headers: { 'content-type': sse ? 'text/event-stream' : 'application/json', 'Mcp-Session-Id': 'secret-mcp-session', 'set-cookie': 'secret-cookie' } });
  Object.defineProperty(response, 'redirected', { value: true }); return response;
}
function fixture(autostart = false) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-http-')); roots.push(root); mkdirSync(join(root, '.saivage'));
  writeFileSync(join(root, '.saivage/saivage.yaml'), stringify({ ...structuredClone(TEST_SAIVAGE_CONFIG), mcpServers: { 'secret-server': { ...config, autostart } } }));
  const processRegistry = new ManagedProcessGroupRegistry(); const scope = processRegistry.createContainerScope(processRegistry.rootScope, 'mcp-servers');
  const runner = new ProcessRunner(root, processRegistry, testApplicationFatalPort); const capture = capturedHttp();
  const manager = new McpManager({ nativeGit: false, configAuthority: testConfigAuthority(root), processRunner: runner, mcpProcessRootScope: scope, eventLogger: { appendEvent() {}, appendEventPrepared() {} } as never, outboundHttp: capture.sink });
  const installation = createMcpToolInvocationInstallation(); installation.installer.install(manager);
  const surface = new BoundAgentToolSet(['mcp_server_control', 'mcp_tool_call'].map(n => resolveRuntimeTool('card', n))).bind({ scope: 'card', agentName: 'executor', projectRoot: root, mcpToolInvocation: installation.port } as never);
  return { manager, surface, ...capture };
}
describe('MCP owner-local observations through installed real tool surface', () => {
  it('agent start attributes initialize/notification/all pages; concurrent callers remain distinct', async () => {
    const f = fixture(); const calls: RequestInit[] = []; const pendingCalls: Array<{ id: number; headers: ReturnType<typeof deferred<Response>>; signal: AbortSignal }> = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      calls.push(init!);
      const body = JSON.parse(String(init!.body));
      if (body.method === 'initialize') return rpc(body.id, {}, true);
      if (body.method === 'notifications/initialized') return new Response('secret-notification-body', { status: 202 });
      if (body.method === 'tools/list') return rpc(body.id, body.params?.cursor
        ? { tools: [] } : { tools: [{ name: 'secret-tool', inputSchema: { type: 'object' } }], nextCursor: 'secret-cursor' });
      const headers = deferred<Response>(); pendingCalls.push({ id: body.id, headers, signal: init!.signal! }); return headers.promise;
    });
    const startOwner = testLlmToolInvocationContext({ sessionId: 'agent:executor:card-a', sourceInputId: '11111111-1111-4111-8111-111111111111', toolName: 'mcp_server_control' });
    await invokeToolForLlm(f.surface, 'mcp_server_control', { serverName: 'secret-server', action: 'start' }, startOwner);
    assertLifecycles(f.records, 4);
    expect(f.records.filter(r => r.event === 'outbound_http_dispatch').map(r => r.purpose)).toEqual(['mcp-initialize', 'mcp-notification', 'mcp-list', 'mcp-list']);
    expect(calls.map(call => call.method)).toEqual(['POST', 'POST', 'POST', 'POST']);
    for (const r of f.records) expect(r).toMatchObject(projectOutboundSource(startOwner.sessionId, startOwner.sourceInputId));
    expect(f.records.filter(r => r.event === 'outbound_http_terminal' && r.purpose === 'mcp-notification')[0]).toMatchObject({ body_disposition: 'not_consumed' });
    const bindingId = f.manager.getServerStatus('secret-server')!.bindingId!;
    const owners = ['card-b', 'card-c'].map((card, i) => testLlmToolInvocationContext({ sessionId: `agent:executor:${card}`, sourceInputId: `${i + 2}${'1'.repeat(7)}-1111-4111-8111-111111111111`, toolName: 'mcp_tool_call' }));
    const pending = owners.map(owner => invokeToolForLlm(f.surface, 'mcp_tool_call', { serverName: 'secret-server', bindingId, catalogId: f.manager.getServerCatalog('secret-server')!.catalogId, toolName: 'secret-tool', args: { password: 'secret-tool-argument' } }, owner));
    await microtasks(); expect(pendingCalls).toHaveLength(2);
    const dispatched = f.records.filter(r => r.event === 'outbound_http_dispatch' && r.purpose === 'mcp-invoke');
    expect(dispatched).toHaveLength(2);
    const streams = pendingCalls.map(call => controlledResponse(call.signal));
    for (let i = 0; i < 2; i++) { pendingCalls[i]!.headers.resolve(streams[i]!.response); await microtasks(); }
    expect(f.records.filter(r => r.event === 'outbound_http_terminal' && r.purpose === 'mcp-invoke')).toHaveLength(0);
    for (const i of [1, 0]) {
      streams[i]!.send(JSON.stringify({ jsonrpc: '2.0', id: pendingCalls[i]!.id, result: { content: [{ type: 'text', text: 'secret-result' }] } })); streams[i]!.close(); await pending[i];
      const phases = f.records.filter(r => 'request_id' in r && r.request_id === dispatched[i]!.request_id);
      expect(phases).toHaveLength(3); for (const r of phases) expect(r).toMatchObject(projectOutboundSource(owners[i]!.sessionId, owners[i]!.sourceInputId));
    }
    assertLifecycles(f.records, 6);
    for (const call of calls) expect(call.redirect).toBeUndefined();
    assertPrivateMetadata(f.records, ['secret-host', 'secret-path', 'secret-query', 'secret-fragment', 'secret-server', 'secret-tool', 'secret-cursor', 'secret-mcp-session', 'secret-cookie', 'secret-notification-body', 'secret-tool-argument', 'secret-result']);
    await f.manager.cleanupForApplicationStop();
  });
  it('autostart has no fabricated tool caller on any discovery request', async () => {
    const f = fixture(true); jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init!.body)); return body.method === 'notifications/initialized' ? new Response(null, { status: 202 }) : rpc(body.id, body.method === 'tools/list' ? { tools: [] } : {});
    });
    expect(await f.manager.reconcilePersistedConfig()).toMatchObject({ converged: true }); assertLifecycles(f.records, 3);
    for (const r of f.records) { expect(r).not.toHaveProperty('source_session'); expect(r).not.toHaveProperty('input_id'); }
    await f.manager.cleanupForApplicationStop();
  });
  it.each(['json-success', 'sse-success', 'json-error', 'sse-error', 'malformed', 'truncated', 'http-error'] as const)('invocation parser owns terminal for %s', async mode => {
    const capture = capturedHttp();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const id = JSON.parse(String(init!.body)).id;
      if (mode === 'http-error') return new Response('secret-wire', { status: 503 });
      if (mode === 'malformed') return new Response('secret-malformed');
      if (mode === 'truncated') return new Response('data: {', { headers: { 'content-type': 'text/event-stream' } });
      const body = JSON.stringify({ jsonrpc: '2.0', id, ...(mode.endsWith('error') ? { error: { code: -32000, message: 'secret-rpc-error' } } : { result: { content: [{ type: 'text', text: 'secret-result' }] } }) });
      return new Response(mode.startsWith('sse') ? `data: ${body}\n\n` : body, { headers: { 'content-type': mode.startsWith('sse') ? 'text/event-stream' : 'application/json' } });
    });
    const pending = invokeStreamableHttpTool({ config, serverName: 'secret-server', toolName: 'secret-tool', args: {}, ids: { next: () => 1 }, signal: new AbortController().signal, timeoutMs: 1000, outboundHttp: capture.sink });
    if (mode.endsWith('success')) await expect(pending).resolves.toHaveProperty('content'); else await expect(pending).rejects.toBeDefined();
    expect(capture.records.at(-1)).toMatchObject({ status: mode === 'http-error' ? 503 : 200, outcome: mode.endsWith('success') ? 'completed' : mode === 'http-error' ? 'http_error' : 'failed', body_disposition: mode === 'http-error' ? 'not_consumed' : mode.startsWith('sse') ? 'cancelled_by_policy' : mode === 'malformed' || mode === 'truncated' || mode.startsWith('json') ? 'consumed' : 'incomplete' });
    assertLifecycles(capture.records, 1); assertPrivateMetadata(capture.records, ['secret-wire', 'secret-malformed', 'secret-rpc-error', 'secret-result', 'secret-server', 'secret-tool']);
  });
  it.each(['timeout', 'cancel'] as const)('pending invocation %s and preabort are normalized without headers', async mode => {
    jest.useFakeTimers(); const capture = capturedHttp(); const owner = new AbortController(); const reason = { exact: 'stop' };
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => pendingHeaders(init!.signal!));
    const input = { config, serverName: 's', toolName: 't', args: {}, ids: { next: () => 1 }, signal: owner.signal, timeoutMs: 1000, outboundHttp: capture.sink };
    const pending = invokeStreamableHttpTool(input).catch(e => e); expect(capture.records).toHaveLength(1);
    if (mode === 'timeout') await jest.advanceTimersByTimeAsync(1000); else owner.abort(reason);
    const error = await pending; if (mode === 'cancel') expect(error).toBe(reason);
    expect(capture.records.at(-1)).toMatchObject({ outcome: mode === 'timeout' ? 'timeout' : 'cancelled', error_code: mode === 'timeout' ? 'deadline' : 'owner_abort' });
    expect(capture.records.at(-1)).not.toHaveProperty('status'); expect(jest.getTimerCount()).toBe(0);
    await expect(invokeStreamableHttpTool({ ...input, signal: AbortSignal.abort(reason) })).rejects.toBe(reason); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['application/json', 'text/event-stream'])('deferred %s body timeout is visible after headers, not successful consumption', async contentType => {
    jest.useFakeTimers(); const capture = capturedHttp();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const stream = controlledResponse(init!.signal!); stream.response.headers.set('content-type', contentType); return stream.response;
    });
    const pending = invokeStreamableHttpTool({ config, serverName: 's', toolName: 't', args: {}, ids: { next: () => 1 }, signal: new AbortController().signal, timeoutMs: 1000, outboundHttp: capture.sink }).catch(e => e);
    await jest.advanceTimersByTimeAsync(0); expect(capture.records.map(r => r.event)).toEqual(['outbound_http_dispatch', 'outbound_http_headers']);
    await jest.advanceTimersByTimeAsync(1000); expect(await pending).toMatchObject({ code: 'TIMEOUT' });
    expect(capture.records.at(-1)).toMatchObject({ status: 200, outcome: 'timeout', error_code: 'deadline', body_disposition: 'incomplete' }); expect(jest.getTimerCount()).toBe(0);
  });
  it('native tool isError is a failed terminal, while throwing ordinary sink preserves results and error behavior', async () => {
    const capture = capturedHttp(); const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => rpc(1, { isError: true, content: [{ type: 'text', text: 'secret-native-failure' }] }));
    const input = { config, serverName: 's', toolName: 't', args: {}, ids: { next: () => 1 }, signal: new AbortController().signal, timeoutMs: 1000 };
    await expect(invokeStreamableHttpTool({ ...input, outboundHttp: capture.sink })).resolves.toMatchObject({ isError: true });
    expect(capture.records.at(-1)).toMatchObject({ status: 200, outcome: 'failed', error_code: 'protocol' });
    const sink = jest.fn(() => { throw new Error('observer'); });
    await expect(invokeStreamableHttpTool({ ...input, outboundHttp: sink })).resolves.toMatchObject({ isError: true });
    const failure = new Error('secret-reader-error');
    fetch.mockImplementation(async () => new Response(new ReadableStream({ start(c) { c.error(failure); } })));
    await expect(invokeStreamableHttpTool({ ...input, outboundHttp: sink })).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(3); expect(sink).toHaveBeenCalledTimes(6); assertPrivateMetadata(capture.records, ['secret-native-failure']);
  });
  it('publication-unknown body failure has no terminal, reader cleanup, owner cleanup or stats publication', async () => {
    jest.useFakeTimers(); const capture = capturedHttp(); const fatal = new PublicationOutcomeUnknownError(); const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock'); const cancel = jest.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ start(c) { c.error(fatal); } })));
    const remove = jest.spyOn(AbortSignal.prototype, 'removeEventListener');
    await expect(invokeStreamableHttpTool({ config, serverName: 's', toolName: 't', args: {}, ids: { next: () => 1 }, signal: new AbortController().signal, timeoutMs: 1000, outboundHttp: capture.sink })).rejects.toBe(fatal);
    expect(capture.records.map(r => r.event)).toEqual(['outbound_http_dispatch', 'outbound_http_headers']); expect(release).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
});
