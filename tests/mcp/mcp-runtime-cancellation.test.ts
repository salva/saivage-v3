import { describe, expect, it, jest } from '@jest/globals';
import { PassThrough } from 'node:stream';
import { McpServerRuntime } from '../../src/mcp/server-runtime.js';
import { McpInvocationStatsRecorder } from '../../src/mcp/invocation-stats.js';
import { TimeoutError, TransportError } from '../../src/mcp/errors.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { createMcpToolInvocationInstallation } from '../../src/mcp/tool-invocation-installation.js';
import { mcpToolBinders } from '../../src/tools/mcp-provider.js';
import { invokeToolForLlm } from '../../src/tools/invocation.js';
import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { testLlmToolInvocationContext, unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const calls: any[] = [];
  const entered = deferred<void>();
  const containment = deferred<any>();
  const terminate = jest.fn(() => containment.promise);
  const runner = {
    spawnInteractive: () => ({ process: { stdin, stdout, stderr: new PassThrough() }, record: { id: 'p' } }),
    get: () => ({ status: 'running' }),
    waitForSettlement: () => new Promise(() => {}),
    closeAndTerminateDirectScope: terminate,
  };
  stdin.on('data', chunk => {
    const request = JSON.parse(chunk.toString());
    if (request.method === 'notifications/initialized') return;
    if (request.method === 'tools/call') { calls.push(request); entered.resolve(); return; }
    const result = request.method === 'initialize' ? {} : { tools: [{ name: 'pending', inputSchema: { type: 'object' } }] };
    setImmediate(() => stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'));
  });
  let id = 0;
  const events = { appendEventPrepared: jest.fn(() => {}) };
  const runtime = new McpServerRuntime({ name: 'one', config: { transport: 'stdio', command: 'test', autostart: true, disabled: false }, revision: 'r', processRunner: runner as never, processScope: {} as never, ids: { next: () => ++id }, invocationStats: new McpInvocationStatsRecorder(events as never) });
  await runtime.start();
  return { runtime, containment, terminate, entered, calls, stdout, events };
}
const success = { failed: [] };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

describe('active stdio cancellation ownership', () => {
  it.each(['unknown', 'caller', 'publication'] as const)('preserves actual HTTP discovery %s identity with the existing containment boundary', async mode => {
    if (mode === 'publication') jest.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const failure = mode === 'publication' ? new PublicationOutcomeUnknownError() : new TypeError('exact discovery reader/caller failure');
    const terminate = jest.fn(async () => success);
    const events = { appendEventPrepared: jest.fn() };
    const caller = new AbortController();
    const runtime = new McpServerRuntime({ name: 'one', config: { transport: 'streamable-http', url: 'http://localhost/mcp', autostart: false, disabled: false }, revision: 'r', processRunner: { closeAndTerminateDirectScope: terminate } as never, processScope: {} as never, ids: { next: () => 1 }, invocationStats: new McpInvocationStatsRecorder(events as never) });
    const cancel = jest.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
    const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    globalThis.fetch = jest.fn(async (_url, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      if (mode === 'caller') { caller.abort(failure); throw new Error('fetch aborted'); }
      return new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
    }) as typeof fetch;
    try {
      await expect(runtime.start(caller.signal)).rejects.toBe(failure);
      expect(failure).not.toBeInstanceOf(TransportError);
      expect(terminate).toHaveBeenCalledTimes(mode === 'publication' ? 0 : 1);
      expect(events.appendEventPrepared).not.toHaveBeenCalled();
      if (mode === 'publication') { expect(cancel).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled(); }
      else { expect(runtime.isContained()).toBe(true); expect(runtime.getTools()).toBeUndefined(); }
      // Publication uncertainty: no owner follow-up or artifact inspection.
    } finally { globalThis.fetch = originalFetch; jest.restoreAllMocks(); if (mode === 'publication') { jest.clearAllTimers(); jest.useRealTimers(); } }
  });
  it.each(['caller', 'deadline'] as const)('preserves %s classification through installed port, reader and real shared tool invocation', async mode => {
    const f = await fixture();
    const installation = createMcpToolInvocationInstallation();
    installation.installer.install({ ...unusedMcpToolInvocation, getServerTools: () => f.runtime.getTools(), findToolCapability: () => null, invokeTool: (_server, tool, args, options) => f.runtime.invokeTool(tool, args, { ...options, timeoutMs: mode === 'deadline' ? 15 : 10_000 }) });
    const surface = buildInvocationSurfaceFixture('executor', [bindToolProvider('mcp', mcpToolBinders, { projectRoot: '/unused', mcpToolInvocation: installation.port })]);
    const caller = new AbortController();
    const result = invokeToolForLlm(surface, 'mcp_tool_call', { serverName: 'one', toolName: 'pending' }, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' }), caller.signal);
    await f.entered.promise;
    if (mode === 'caller') caller.abort({ exact: 'non-default caller reason' });
    else {
      await new Promise(resolve => setTimeout(resolve, 30));
      caller.abort({ exact: 'later caller reason' }); // Must not relabel the winning deadline.
    }
    f.containment.resolve(success);
    const settlement = await result;
    if (mode === 'caller') expect(settlement).toMatchObject({ kind: 'execution_failed' });
    else expect(settlement).toMatchObject({ kind: 'executed', execution: { providerOutcome: { kind: 'failed', error: expect.stringContaining('timed out') } } });
    expect(f.runtime.isContained()).toBe(true);
    expect(f.events.appendEventPrepared).not.toHaveBeenCalled();
  });

  it('event publication uncertainty after a complete response escapes before any stop or later logging', async () => {
    const f = await fixture();
    const failure = new PublicationOutcomeUnknownError();
    f.events.appendEventPrepared.mockImplementation(() => { throw failure; });
    const observed = f.runtime.invokeTool('pending', {}).catch(error => error);
    await f.entered.promise;
    f.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: f.calls[0].id, result: { content: [] } }) + '\n');
    expect(await observed).toBe(failure);
    expect(f.terminate).not.toHaveBeenCalled();
    expect(f.events.appendEventPrepared).toHaveBeenCalledTimes(1);
    // Mock-only streams: no real process owner needs follow-up containment.
  });

  it.each(['caller', 'deadline'] as const)('%s synchronously fences discovery, drains two queued calls and joins direct containment without self-join', async mode => {
    const f = await fixture();
    const caller = new AbortController();
    const reason = { exact: 'caller reason' };
    let settled = false;
    const active = f.runtime.invokeTool('pending', {}, { signal: caller.signal, timeoutMs: mode === 'deadline' ? 15 : 10_000 });
    const observed = active.then(() => undefined, error => { settled = true; return error; });
    await f.entered.promise;
    const queued = [f.runtime.invokeTool('pending', {}), f.runtime.invokeTool('pending', {})].map(p => p.catch(error => error));
    if (mode === 'caller') caller.abort(reason);
    else await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.runtime.isReady()).toBe(false);
    expect(f.runtime.getTools()).toBeUndefined();
    expect(f.terminate).toHaveBeenCalledTimes(1);
    const stopping = f.runtime.stop();
    await turn();
    expect(settled).toBe(false);
    expect(f.calls).toHaveLength(1);
    f.containment.resolve(success);
    const error = await observed;
    if (mode === 'caller') expect(error).toBe(reason);
    else expect(error).toBeInstanceOf(TimeoutError);
    await Promise.all([stopping, ...queued]);
    expect(f.runtime.isContained()).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it('queued-only cancellation writes nothing and does not invalidate the active exchange; completed response detaches invalidation', async () => {
    const f = await fixture();
    const activeCaller = new AbortController();
    const active = f.runtime.invokeTool('pending', {}, { signal: activeCaller.signal });
    await f.entered.promise;
    const caller = new AbortController();
    const reason = new Error('queued cancellation');
    const queued = f.runtime.invokeTool('pending', {}, { signal: caller.signal }).catch(error => error);
    caller.abort(reason);
    expect(f.runtime.isReady()).toBe(true);
    expect(f.terminate).not.toHaveBeenCalled();
    f.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: f.calls[0].id, result: { content: [] } }) + '\n');
    await active;
    activeCaller.abort(reason);
    expect(await queued).toBe(reason);
    expect(f.calls).toHaveLength(1);
    expect(f.terminate).not.toHaveBeenCalled();
    f.containment.resolve(success);
    await f.runtime.stop();
  });

  it.each(['report', 'rejection'] as const)('containment %s takes precedence and retains the closed owner', async mode => {
    const f = await fixture();
    const caller = new AbortController();
    const observed = f.runtime.invokeTool('pending', {}, { signal: caller.signal }).catch(error => error);
    await f.entered.promise;
    caller.abort(new Error('routine cancellation'));
    const failure = new Error('fatal containment');
    if (mode === 'report') f.containment.resolve({ failed: ['group'] });
    else f.containment.reject(failure);
    const error = await observed;
    if (mode === 'rejection') expect(error).toBe(failure);
    else expect((error as Error).message).toContain('containment failed');
    expect(f.runtime.isContained()).toBe(false);
    expect(f.runtime.getTools()).toBeUndefined();
    expect(f.terminate).toHaveBeenCalledTimes(1);
  });
});
