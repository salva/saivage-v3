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
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
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
  const events = { appendEventPrepared: jest.fn((_prepare: () => unknown) => {}) };
  const stats = new McpInvocationStatsRecorder(events as never);
  const runtime = new McpServerRuntime({ name: 'one', config: { transport: 'stdio', command: 'test', autostart: true, disabled: false }, revision: 'r', processRunner: runner as never, processScope: {} as never, ids: { next: () => ++id }, invocationStats: stats });
  await runtime.start();
  return { runtime, catalogId: runtime.getCatalog()!.catalogId, containment, terminate, entered, calls, stdout, events, stats };
}
const success = { failed: [] };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

describe('active stdio cancellation ownership', () => {
  it.each(['expiry', 'success'] as const)('uses the real installed/shared default for 900000ms (%s), not a 30-second outer cap', async mode => {
    // Initialize with real timers: the fixture's peer replies with setImmediate.
    const f = await fixture();
    const installation = createMcpToolInvocationInstallation();
    installation.installer.install({ ...unusedMcpToolInvocation, findToolCapability: () => null, invokeTool: (_server, binding, catalog, tool, args, options) => f.runtime.invokeTool(binding, catalog, tool, args, options) });
    const surface = buildInvocationSurfaceFixture('executor', [bindToolProvider('mcp', mcpToolBinders, { projectRoot: '/unused', mcpToolInvocation: installation.port })]);
    jest.useFakeTimers();
    try {
      let settled = false;
      const result = invokeToolForLlm(surface, 'mcp_tool_call', { serverName: 'one', bindingId: f.runtime.bindingId, catalogId: f.catalogId, toolName: 'pending' }, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' })).then(value => { settled = true; return value; });
      await f.entered.promise;
      for (const delta of [30_000, 35_000, 834_999]) {
        await jest.advanceTimersByTimeAsync(delta);
        expect(settled).toBe(false);
        expect(f.runtime.isReady()).toBe(true);
        expect(f.runtime.getCatalog()?.catalogId).toBe(f.catalogId);
        expect(f.terminate).not.toHaveBeenCalled();
        expect(f.calls).toHaveLength(1);
      }
      if (mode === 'success') {
        f.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: f.calls[0].id, result: { content: [] } }) + '\n');
        expect(await result).toMatchObject({ kind: 'executed', execution: { providerOutcome: { kind: 'succeeded' } } });
        await jest.advanceTimersByTimeAsync(0);
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(900_000);
        expect(f.runtime.isReady()).toBe(true);
        expect(f.terminate).not.toHaveBeenCalled();
      } else {
        await jest.advanceTimersByTimeAsync(1);
        expect(f.runtime.isAdmissionOpen()).toBe(false);
        expect(f.runtime.isReady()).toBe(false);
        expect(f.runtime.getCatalog()).toBeUndefined();
        expect(f.terminate).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false); // Public completion must still join containment.
        const stopping = f.runtime.stop();
        f.containment.resolve(success);
        const execution = await result;
        expect(execution).toMatchObject({ kind: 'executed', execution: { providerOutcome: { kind: 'failed' } } });
        const outcome = execution.kind === 'executed' ? execution.execution.providerOutcome : execution.providerOutcome;
        expect(settleToolActionOutcome(outcome).providerResult).toMatchObject({ success: false, error: expect.stringContaining('900000ms') });
        await stopping;
        expect(f.runtime.isContained()).toBe(true);
        expect(f.calls).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(0);
        expect(jest.getTimerCount()).toBe(0);
      }
    } finally {
      f.containment.resolve(success);
      try { await f.runtime.stop(); } finally { jest.useRealTimers(); }
    }
  });

  it.each(['fetch', 'body', 'success'] as const)('forwards the default to the HTTP request/body owner (%s) without claiming remote shutdown', async mode => {
    const originalFetch = globalThis.fetch;
    const entered = deferred<void>();
    const terminate = jest.fn(async () => success);
    let requestSignal: AbortSignal | undefined;
    let finishBody: (() => void) | undefined;
    let calls = 0;
    globalThis.fetch = jest.fn(async (_url, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (request.method === 'tools/call') {
        calls++;
        requestSignal = init!.signal!;
        entered.resolve();
        if (mode === 'fetch') return new Promise<Response>((_resolve, reject) => requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true }));
        return new Response(new ReadableStream({ start(controller) {
          requestSignal!.addEventListener('abort', () => controller.error(requestSignal!.reason), { once: true });
          finishBody = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [] } }))); controller.close(); };
        } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize' ? {} : { tools: [{ name: 'pending', inputSchema: { type: 'object' } }] } }));
    }) as typeof fetch;
    let id = 0;
    const runtime = new McpServerRuntime({ name: 'one', config: { transport: 'streamable-http', url: 'http://localhost/mcp', autostart: false, disabled: false }, revision: 'r', processRunner: { closeAndTerminateDirectScope: terminate } as never, processScope: {} as never, ids: { next: () => ++id }, invocationStats: new McpInvocationStatsRecorder({ appendEventPrepared() {} } as never) });
    try {
      await runtime.start();
      const catalog = runtime.getCatalog()!;
      jest.useFakeTimers();
      let settled = false;
      const observed = runtime.invokeTool(runtime.bindingId, catalog.catalogId, 'pending', {}).then(value => { settled = true; return value; }, error => { settled = true; return error; });
      await entered.promise;
      for (const delta of [30_000, 35_000, 834_999]) {
        await jest.advanceTimersByTimeAsync(delta);
        expect(settled).toBe(false);
        expect(requestSignal!.aborted).toBe(false);
        expect(runtime.isReady()).toBe(true);
      }
      if (mode === 'success') {
        finishBody!();
        expect(await observed).toEqual({ content: [] });
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(900_000);
        expect(requestSignal!.aborted).toBe(false);
      } else {
        await jest.advanceTimersByTimeAsync(1);
        const error = await observed;
        expect(error).toBeInstanceOf(TimeoutError);
        expect(error).toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining('900000ms') });
        expect(requestSignal!.aborted).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
      }
      expect(calls).toBe(1);
      expect(runtime.getCatalog()).toEqual(catalog);
      expect(runtime.isReady()).toBe(true);
      expect(terminate).not.toHaveBeenCalled(); // Request abort is not remote containment.
    } finally {
      try { await runtime.stop(); } finally { globalThis.fetch = originalFetch; jest.useRealTimers(); }
    }
  });

  it.each(['startup', 'refresh'] as const)('keeps the distinct %s budget across paginated discovery', async phase => {
    const originalFetch = globalThis.fetch;
    const methods: string[] = [];
    const terminate = jest.fn(async () => success);
    let refreshing = false;
    globalThis.fetch = jest.fn(async (_url, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      methods.push(request.method);
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (request.method === 'initialize') {
        if (phase === 'startup') await new Promise(resolve => setTimeout(resolve, 100_000));
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }));
      }
      if (phase === 'refresh' && !refreshing) return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [] } }));
      if (!request.params?.cursor) {
        if (phase === 'refresh') await new Promise(resolve => setTimeout(resolve, 20_000));
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [], nextCursor: 'last' } }));
      }
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
    }) as typeof fetch;
    let id = 0;
    const runtime = new McpServerRuntime({ name: 'one', config: { transport: 'streamable-http', url: 'http://localhost/mcp', autostart: false, disabled: false }, revision: 'r', processRunner: { closeAndTerminateDirectScope: terminate } as never, processScope: {} as never, ids: { next: () => ++id }, invocationStats: new McpInvocationStatsRecorder({ appendEventPrepared() {} } as never) });
    try {
      if (phase === 'refresh') { await runtime.start(); methods.length = 0; refreshing = true; }
      const previous = runtime.getCatalog();
      jest.useFakeTimers();
      let settled = false;
      const budget = phase === 'startup' ? 180_000 : 30_000;
      const operation = (phase === 'startup' ? runtime.start() : runtime.refreshCatalog(runtime.bindingId)).catch(error => { settled = true; return error; });
      await jest.advanceTimersByTimeAsync(budget - 1);
      expect(methods).toEqual(phase === 'startup' ? ['initialize', 'notifications/initialized', 'tools/list', 'tools/list'] : ['tools/list', 'tools/list']);
      expect(settled).toBe(false);
      expect(terminate).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(await operation).toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining(`${budget}ms`) });
      expect(runtime.isReady()).toBe(phase === 'refresh');
      expect(runtime.isContained()).toBe(phase === 'startup');
      expect(terminate).toHaveBeenCalledTimes(phase === 'startup' ? 1 : 0);
      if (phase === 'refresh') expect(runtime.getCatalog()).toEqual(previous);
      expect(jest.getTimerCount()).toBe(0);
    } finally { try { await runtime.stop(); } finally { globalThis.fetch = originalFetch; jest.useRealTimers(); } }
  });

  it.each(['unknown', 'caller', 'publication'] as const)('preserves actual HTTP discovery %s identity with the existing containment boundary', async mode => {
    if (mode === 'publication') jest.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const failure = mode === 'publication' ? new PublicationOutcomeUnknownError() : new TypeError('exact discovery reader/caller failure');
    const containment = deferred<typeof success>();
    const entered = deferred<void>();
    const terminate = jest.fn(() => { entered.resolve(); return containment.promise; });
    const events = { appendEventPrepared: jest.fn() };
    const caller = new AbortController();
    const runtime = new McpServerRuntime({ name: 'one', config: { transport: 'streamable-http', url: 'http://localhost/mcp', autostart: false, disabled: false }, revision: 'r', processRunner: { closeAndTerminateDirectScope: terminate } as never, processScope: {} as never, ids: { next: () => 1 }, invocationStats: new McpInvocationStatsRecorder(events as never) });
    const cancel = jest.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
    const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    globalThis.fetch = jest.fn(async () => {
      if (mode === 'caller') { caller.abort(failure); throw new Error('fetch aborted'); }
      return new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
    }) as typeof fetch;
    try {
      let settled = false;
      const start = runtime.start({ signal: caller.signal }).catch(error => { settled = true; return error; });
      if (mode !== 'publication') {
        await entered.promise;
        await turn();
        expect(settled).toBe(false);
        expect(runtime.isAdmissionOpen()).toBe(false);
        expect(runtime.isReady()).toBe(false);
        expect(runtime.getTools()).toBeUndefined();
        containment.resolve(success);
      }
      expect(await start).toBe(failure);
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
    installation.installer.install({ ...unusedMcpToolInvocation, findToolCapability: () => null, invokeTool: (_server, binding, catalog, tool, args, options) => f.runtime.invokeTool(binding, catalog, tool, args, { ...options, timeoutMs: mode === 'deadline' ? 15 : 10_000 }) });
    const surface = buildInvocationSurfaceFixture('executor', [bindToolProvider('mcp', mcpToolBinders, { projectRoot: '/unused', mcpToolInvocation: installation.port })]);
    const caller = new AbortController();
    const result = invokeToolForLlm(surface, 'mcp_tool_call', { serverName: 'one', bindingId: f.runtime.bindingId, catalogId: f.catalogId, toolName: 'pending' }, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' }), caller.signal);
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

  it.each([
    { isError: false, uncertain: true }, { isError: true, uncertain: true },
    { isError: false, uncertain: false }, { isError: true, uncertain: false },
  ])('event publication rejection after native $isError (uncertain=$uncertain) escapes before any stop or later logging', async ({ isError, uncertain }) => {
    const f = await fixture();
    const failure = uncertain ? new PublicationOutcomeUnknownError() : new Error('exact ordinary event publication failure');
    f.events.appendEventPrepared.mockImplementation(() => { throw failure; });
    const observed = f.runtime.invokeTool(f.runtime.bindingId, f.catalogId, 'pending', {}).catch(error => error);
    await f.entered.promise;
    f.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: f.calls[0].id, result: { content: [], isError } }) + '\n');
    expect(await observed).toBe(failure);
    expect(f.terminate).not.toHaveBeenCalled();
    expect(f.events.appendEventPrepared).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(1);
    expect(f.stats.snapshot()['one:pending']).toMatchObject({ total: 1, success: isError ? 0 : 1, error: isError ? 1 : 0 });
    expect(f.events.appendEventPrepared.mock.calls[0][0]()).toMatchObject({ success: !isError });
    // Mock-only streams: no real process owner needs follow-up containment.
  });

  it('later recognized image conversion failure leaves the actual native invocation successful without replay', async () => {
    const f = await fixture();
    const installation = createMcpToolInvocationInstallation();
    installation.installer.install({ ...unusedMcpToolInvocation, findToolCapability: () => null, invokeTool: (_server, binding, catalog, tool, args, options) => f.runtime.invokeTool(binding, catalog, tool, args, options) });
    const surface = buildInvocationSurfaceFixture('executor', [bindToolProvider('mcp', mcpToolBinders, { projectRoot: '/unused', mcpToolInvocation: installation.port })]);
    const result = invokeToolForLlm(surface, 'mcp_tool_call', { serverName: 'one', bindingId: f.runtime.bindingId, catalogId: f.catalogId, toolName: 'pending' }, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' }));
    await f.entered.promise;
    f.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: f.calls[0].id, result: { content: [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }] } }) + '\n');
    const execution = await result;
    const settled = settleToolActionOutcome(execution.kind === 'executed' ? execution.execution.providerOutcome : execution.providerOutcome).providerResult;
    expect(settled).toMatchObject({ success: false, error: 'Invalid or oversized image; generate a smaller valid source.' });
    expect(f.stats.snapshot()['one:pending']).toMatchObject({ total: 1, success: 1, error: 0 });
    expect(f.events.appendEventPrepared).toHaveBeenCalledTimes(1);
    expect(f.events.appendEventPrepared.mock.calls[0][0]()).toMatchObject({ success: true });
    expect(f.calls).toHaveLength(1);
    expect(f.terminate).not.toHaveBeenCalled();
    f.containment.resolve(success);
    await f.runtime.stop();
  });

  it.each([
    { response: { error: { code: -32602, message: 'invalid remote arguments' } }, code: 'INVALID_ARGUMENTS' },
    { response: { error: { code: -32001, message: 'remote failure' } }, code: 'MCP_ERROR_-32001' },
    { response: { result: { content: [{ type: 'text', text: 1 }] } }, code: 'MCP_INVALID_RESULT' },
    { response: {}, code: 'MCP_NO_RESULT' },
  ])('retains mapped $code rejection with one eligible failure record rather than native success', async ({ response, code }) => {
    const f = await fixture();
    const observed = f.runtime.invokeTool(f.runtime.bindingId, f.catalogId, 'pending', {}).catch(error => error);
    await f.entered.promise;
    f.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: f.calls[0].id, ...response }) + '\n');
    expect(await observed).toMatchObject({ code });
    expect(f.stats.snapshot()['one:pending']).toMatchObject({ total: 1, success: 0, error: 1 });
    expect(f.events.appendEventPrepared).toHaveBeenCalledTimes(1);
    expect(f.events.appendEventPrepared.mock.calls[0][0]()).toMatchObject({ success: false, error: expect.any(String) });
    expect(f.calls).toHaveLength(1);
    expect(f.terminate).not.toHaveBeenCalled();
    f.containment.resolve(success);
    await f.runtime.stop();
  });

  it('unknown tool and already-aborted caller add no invocation or telemetry', async () => {
    const f = await fixture();
    await expect(f.runtime.invokeTool(f.runtime.bindingId, f.catalogId, 'unknown', {})).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' });
    const caller = new AbortController();
    const reason = new Error('already cancelled');
    caller.abort(reason);
    await expect(f.runtime.invokeTool(f.runtime.bindingId, f.catalogId, 'pending', {}, { signal: caller.signal })).rejects.toBe(reason);
    expect(f.calls).toHaveLength(0);
    expect(f.events.appendEventPrepared).not.toHaveBeenCalled();
    expect(f.stats.snapshot()).toEqual({});
    f.containment.resolve(success);
    await f.runtime.stop();
  });

  it.each(['caller', 'deadline'] as const)('%s synchronously fences discovery, drains two queued calls and joins direct containment without self-join', async mode => {
    const f = await fixture();
    const caller = new AbortController();
    const reason = { exact: 'caller reason' };
    let settled = false;
    const active = f.runtime.invokeTool(f.runtime.bindingId, f.catalogId, 'pending', {}, { signal: caller.signal, timeoutMs: mode === 'deadline' ? 15 : 10_000 });
    const observed = active.then(() => undefined, error => { settled = true; return error; });
    await f.entered.promise;
    const queued = [f.runtime.invokeTool(f.runtime.bindingId, f.catalogId, 'pending', {}), f.runtime.invokeTool(f.runtime.bindingId, f.catalogId, 'pending', {})].map(p => p.catch(error => error));
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
    const active = f.runtime.invokeTool(f.runtime.bindingId, f.catalogId, 'pending', {}, { signal: activeCaller.signal });
    await f.entered.promise;
    const caller = new AbortController();
    const reason = new Error('queued cancellation');
    const queued = f.runtime.invokeTool(f.runtime.bindingId, f.catalogId, 'pending', {}, { signal: caller.signal }).catch(error => error);
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
    const observed = f.runtime.invokeTool(f.runtime.bindingId, f.catalogId, 'pending', {}, { signal: caller.signal }).catch(error => error);
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
