import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as YAML from 'yaml';
import { McpManager, ServerNotRunningError } from '../../src/mcp/mcp-manager.js';
import { McpInvocationStatsRecorder } from '../../src/mcp/invocation-stats.js';
import { McpServerRuntime } from '../../src/mcp/server-runtime.js';
import { ManagedProcessGroupRegistry, type ManagedProcessPlatform, type ManagedProcessScope } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { testConfigAuthority } from '../helpers/canonical-project.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';
import { dataPropertyGraphContains } from '../helpers/data-property-graph.js';
import { createAppTerminalCoordinator } from '../../src/boot/app.js';

const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-mcp-reconcile-'));
  roots.push(root);
  return root;
}

function baseConfig(mcpServers: Record<string, unknown>): Record<string, unknown> {
  return {
    server: { port: 8080, host: '127.0.0.1' },
    models: { default: ['test-model'], max_tokens: { analyst: 200 } },
    providers: { test: { priority: 10, models: ['test-model'], apiKey: 'synthetic-secret' } },
    compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'test', account: null, model: 'test-model' } },
    card_processes: DEFAULT_CARD_PROCESSES,
    mcpServers,
  };
}

function writeConfig(root: string, mcpServers: Record<string, unknown>): void {
  mkdirSync(join(root, '.saivage'), { recursive: true });
  writeFileSync(join(root, '.saivage', 'saivage.yaml'), YAML.stringify(baseConfig(mcpServers)));
}

function stdio(command: string): Record<string, unknown> {
  return { transport: 'stdio', command, args: [], env: { TOKEN: 'synthetic-mcp-secret' }, autostart: true, disabled: false };
}

function http(url: string): Record<string, unknown> {
  return { transport: 'streamable-http', url, autostart: true, disabled: false };
}

function createChild(pid: number) {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).trim().split('\n')) {
        const request = JSON.parse(line) as { id?: number; method: string };
        if (request.method === 'initialize') setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18' } })}\n`));
        if (request.method === 'tools/list') setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] } })}\n`));
        if (request.method === 'tools/call') setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: ['pong'] } })}\n`));
      }
      callback();
    },
  });
  return Object.assign(emitter, { pid, stdin, stdout, stderr: new PassThrough(), killed: false, exitCode: null as number | null });
}

function createManager(root: string, control: { failStop?: boolean } = {}) {
  let pid = 22000;
  const children = new Map<number, ReturnType<typeof createChild>>();
  const spawn = jest.fn(() => {
    const child = createChild(pid++);
    children.set(child.pid, child);
    return child;
  });
  const signal = jest.fn((pgid: number, sent: NodeJS.Signals) => {
    const child = children.get(pgid)!;
    child.killed = true;
    child.exitCode = sent === 'SIGKILL' ? 137 : 0;
    child.emit('exit', child.exitCode, sent);
    child.emit('close', child.exitCode, sent);
  });
  const platform: ManagedProcessPlatform = {
    spawn: spawn as never,
    signal,
    probe: (pgid) => {
      if (control.failStop) throw Object.assign(new Error('ambiguous'), { code: 'EPERM' });
      const child = children.get(pgid)!;
      if (child.killed) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    },
  };
  const registry = new ManagedProcessGroupRegistry(platform);
  const mcpProcessRootScope = registry.createContainerScope(registry.rootScope, 'mcp-servers');
  const processRunner = new ProcessRunner(root, registry);
  const revisionScopes: object[] = [];
  const createDirectScope = processRunner.createDirectScope.bind(processRunner);
  jest.spyOn(processRunner, 'createDirectScope').mockImplementation((...args) => {
    const scope = createDirectScope(...args);
    revisionScopes.push(scope);
    return scope;
  });
  const managerOptions = { configAuthority: testConfigAuthority(root), processRunner, mcpProcessRootScope, eventLogger: { appendEvent() {} } as any };
  return { manager: new McpManager(managerOptions), managerOptions, processRunner, mcpProcessRootScope, revisionScopes, spawn, signal };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function rpcResponse(id: number, result: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function successfulHttpFetch() {
  return jest.fn(async (_url: string | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 200 });
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'initialize') return rpcResponse(request.id, { protocolVersion: '2025-06-18' });
    if (request.method === 'tools/list') return rpcResponse(request.id, { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] });
    return rpcResponse(request.id, { content: ['pong'] });
  });
}

beforeEach(() => { globalThis.fetch = successfulHttpFetch() as typeof fetch; });
afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe('persisted MCP reconciliation', () => {
  it('starts independent stdio and HTTP runtimes and reports secret-free deterministic revisions', async () => {
    const root = projectRoot();
    writeConfig(root, { stdioA: stdio('a'), stdioB: stdio('b'), httpA: http('http://user:password@localhost/a'), httpB: http('http://localhost/b') });
    const { manager, spawn } = createManager(root);

    const first = await manager.reconcilePersistedConfig();
    const second = await manager.reconcilePersistedConfig();

    expect(first.converged).toBe(true);
    expect(first.active).toHaveLength(4);
    expect(first.active.every((entry) => entry.state === 'running')).toBe(true);
    expect(second.desired).toEqual(first.desired);
    expect(spawn).toHaveBeenCalledTimes(2);
    const rendered = JSON.stringify(first);
    expect(rendered).not.toContain('synthetic-mcp-secret');
    expect(rendered).not.toContain('password');
    expect(rendered).not.toContain('http://');
    expect(rendered).not.toContain('command');
  });

  it('launches stdio servers with sanitized inheritance and the exact configured overlay', async () => {
    const touched = ['PATH', 'HOME', 'LC_SAIVAGE_TEST', 'SAIVAGE_API_TOKEN', 'OPENAI_API_KEY', 'DEPLOYMENT_PRIVATE_VALUE'] as const;
    const original = new Map(touched.map((key) => [key, process.env[key]]));
    try {
      process.env.PATH = '/ambient/safe/path';
      process.env.HOME = '/ambient/safe/home';
      process.env.LC_SAIVAGE_TEST = 'safe-locale';
      process.env.SAIVAGE_API_TOKEN = 'ambient-api-credential';
      process.env.OPENAI_API_KEY = 'ambient-provider-credential';
      process.env.DEPLOYMENT_PRIVATE_VALUE = 'ambient-deployment-credential';
      const root = projectRoot();
      writeConfig(root, {
        one: {
          ...stdio('one'),
          env: { TOKEN: 'explicit-mcp-credential', PATH: '/configured/mcp/path' },
        },
      });
      const { manager, spawn } = createManager(root);

      await manager.reconcilePersistedConfig();

      const options = (spawn.mock.calls as unknown as Array<[string, readonly string[], { env: NodeJS.ProcessEnv }]>)[0]![2];
      expect(options.env.HOME).toBe('/ambient/safe/home');
      expect(options.env.LC_SAIVAGE_TEST).toBe('safe-locale');
      expect(options.env.PATH).toBe('/configured/mcp/path');
      expect(options.env.TOKEN).toBe('explicit-mcp-credential');
      expect(options.env.SAIVAGE_API_TOKEN).toBeUndefined();
      expect(options.env.OPENAI_API_KEY).toBeUndefined();
      expect(options.env.DEPLOYMENT_PRIVATE_VALUE).toBeUndefined();
    } finally {
      for (const key of touched) {
        const value = original.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('keeps manager process authority and retained runtimes structurally unreachable while preserving public projections', async () => {
    const root = projectRoot();
    writeConfig(root, { one: http('http://localhost/one') });
    const { manager, managerOptions, processRunner, mcpProcessRootScope, revisionScopes } = createManager(root);

    const report = await manager.reconcilePersistedConfig();

    expect(report.converged).toBe(true);
    expect(manager.getStatus()).toEqual([expect.objectContaining({ name: 'one', status: 'running' })]);
    expect(manager.getTools()).toEqual([expect.objectContaining({ name: 'ping' })]);
    expect(revisionScopes).toHaveLength(1);
    expect(dataPropertyGraphContains(manager, new Set([managerOptions, processRunner, mcpProcessRootScope, revisionScopes[0]]))).toBe(false);
  });

  it('keeps a directly held runtime runner and scope private and reuses its exact one-shot containment', async () => {
    const processScope = {} as ManagedProcessScope;
    const containment = deferred<{ selected: string[]; stopped: string[]; failed: [] }>();
    const closeAndTerminateDirectScope = jest.fn(() => containment.promise);
    const processRunner = { closeAndTerminateDirectScope };
    const config = { transport: 'streamable-http', url: 'http://localhost/runtime', autostart: true, disabled: false } as const;
    const runtimeOptions = {
      name: 'direct', config, revision: 'revision', processRunner: processRunner as never, processScope,
      ids: { next: () => 1 }, invocationStats: new McpInvocationStatsRecorder({ appendEvent() {} } as never),
    };
    const runtime = new McpServerRuntime(runtimeOptions);

    expect(dataPropertyGraphContains(runtime, new Set([runtimeOptions, processRunner, processScope]))).toBe(false);
    expect(runtime.name).toBe('direct');
    expect(runtime.config).toBe(config);
    expect(runtime.revision).toBe('revision');
    const first = runtime.closeAdmission();
    const second = runtime.closeAdmission();

    expect(second).toBe(first);
    expect(closeAndTerminateDirectScope).toHaveBeenCalledTimes(1);
    expect(closeAndTerminateDirectScope).toHaveBeenCalledWith({
      directScope: processScope,
      category: 'service_infrastructure',
      reason: "MCP server 'direct' stopped",
    });
    containment.resolve({ selected: [], stopped: [], failed: [] });
    await expect(first).resolves.toBeUndefined();
    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(closeAndTerminateDirectScope).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus()).toEqual(expect.objectContaining({ name: 'direct', status: 'stopped' }));
  });

  it('serializes concurrent reconciliations without duplicate runtimes', async () => {
    const root = projectRoot();
    writeConfig(root, { one: stdio('one') });
    const { manager, spawn } = createManager(root);

    const reports = await Promise.all([manager.reconcilePersistedConfig(), manager.reconcilePersistedConfig()]);

    expect(reports.every((report) => report.converged)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('preflights more than one destructive target before lifecycle mutation', async () => {
    const root = projectRoot();
    writeConfig(root, { one: stdio('one'), two: stdio('two') });
    const { manager, signal } = createManager(root);
    await manager.reconcilePersistedConfig();
    writeConfig(root, { one: stdio('changed-one'), two: stdio('changed-two') });

    const report = await manager.reconcilePersistedConfig();
    expect(report.converged).toBe(false);
    expect(report.pending).toHaveLength(2);
    expect(signal).not.toHaveBeenCalled();
    expect(manager.getStatus().every((status) => status.status === 'running')).toBe(true);
  });

  it('retains the exact old revision and starts no successor when replacement containment fails', async () => {
    const root = projectRoot();
    writeConfig(root, { one: stdio('old') });
    const control = { failStop: false };
    const { manager, spawn } = createManager(root, control);
    const initial = await manager.reconcilePersistedConfig();
    const oldRevision = initial.active[0]!.revision;
    writeConfig(root, { one: stdio('new') });
    control.failStop = true;

    const report = await manager.reconcilePersistedConfig();

    expect(report.converged).toBe(false);
    expect(report.pending).toEqual([expect.objectContaining({ name: 'one', operation: 'replace' })]);
    expect(report.active).toEqual([{ name: 'one', revision: oldRevision, state: 'running' }]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('retains no running old revision after successor failure and retries from persisted desired state', async () => {
    const root = projectRoot();
    writeConfig(root, { one: http('http://localhost/old') });
    const { manager } = createManager(root);
    await manager.reconcilePersistedConfig();
    writeConfig(root, { one: http('http://localhost/new') });
    globalThis.fetch = jest.fn(async () => new Response(null, { status: 503 })) as typeof fetch;

    const failed = await manager.reconcilePersistedConfig();
    expect(failed.converged).toBe(false);
    expect(failed.active).toEqual([expect.objectContaining({ name: 'one', state: 'stopped' })]);
    expect(failed.active[0]!.revision).toBe(failed.desired[0]!.revision);

    globalThis.fetch = successfulHttpFetch() as typeof fetch;
    const retried = await manager.reconcilePersistedConfig();
    expect(retried.converged).toBe(true);
    expect(retried.active).toEqual([expect.objectContaining({ name: 'one', revision: retried.desired[0]!.revision, state: 'running' })]);
  });

  it('aborts and joins HTTP invocation work before remove and suppresses late publication', async () => {
    const root = projectRoot();
    writeConfig(root, { one: http('http://localhost/one') });
    const { manager } = createManager(root);
    await manager.reconcilePersistedConfig();
    globalThis.fetch = jest.fn((_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })) as typeof fetch;

    const invocation = manager.invokeTool('one', 'ping', {});
    writeConfig(root, {});
    const report = await manager.reconcilePersistedConfig();

    await expect(invocation).rejects.toThrow();
    expect(report.converged).toBe(true);
    expect(report.active).toEqual([]);
    expect(manager.getInvocationStats()).toEqual({});
  });

  it('invalid persisted config performs no lifecycle mutation', async () => {
    const root = projectRoot();
    writeConfig(root, { one: stdio('one') });
    const { manager, signal, spawn } = createManager(root);
    const before = await manager.reconcilePersistedConfig();
    const invalidConfigs = [
      { ...baseConfig({}), mcpServers: 'invalid' },
      baseConfig({ one: { transport: 'stdio', url: 'https://example.com/mcp' } }),
    ];

    for (const invalid of invalidConfigs) {
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), YAML.stringify(invalid));
      await expect(manager.reconcilePersistedConfig()).rejects.toThrow();
      expect(signal).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(manager.getStatus()[0]?.status).toBe('running');
      expect(before.active[0]?.revision).toBeDefined();
    }
  });

  it('closes invocation and runtime admission synchronously, then reuses direct containment before root cleanup', async () => {
    const root = projectRoot();
    writeConfig(root, { one: http('http://localhost/one') });
    const { manager, processRunner, mcpProcessRootScope } = createManager(root);
    await manager.reconcilePersistedConfig();
    const transportCalls = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const events: string[] = [];
    const directImplementation = processRunner.closeAndTerminateDirectScope.bind(processRunner);
    const directContainment = jest.spyOn(processRunner, 'closeAndTerminateDirectScope').mockImplementation((input) => {
      events.push('direct');
      return directImplementation(input);
    });
    const rootImplementation = processRunner.terminateScopeTree.bind(processRunner);
    const rootContainment = jest.spyOn(processRunner, 'terminateScopeTree').mockImplementation((input) => {
      events.push('root');
      return rootImplementation(input);
    });

    manager.closeAdmission();
    expect(events).toEqual(['direct']);
    await expect(manager.reconcilePersistedConfig()).rejects.toThrow('closed');
    await expect(manager.invokeTool('one', 'ping', {})).rejects.toBeInstanceOf(ServerNotRunningError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(transportCalls);
    await manager.cleanupForApplicationStop();

    expect(events).toEqual(['direct', 'root']);
    expect(directContainment).toHaveBeenCalledTimes(1);
    expect(directContainment).toHaveBeenCalledWith(expect.objectContaining({ directScope: expect.any(Object) }));
    expect(rootContainment).toHaveBeenCalledWith({ rootScope: mcpProcessRootScope, categories: ['service_infrastructure'], reason: 'application stopping', graceMs: 5000 });
    expect(manager.getStatus()).toEqual([]);
  });

  it('preserves root rejection precedence and retains runtimes after incomplete cleanup', async () => {
    const root = projectRoot();
    writeConfig(root, { one: http('http://localhost/one') });
    const directError = new Error('direct containment failed');
    const rootError = new Error('root containment failed');
    const revisionScope = {} as ManagedProcessScope;
    const processRunner = {
      createDirectScope: jest.fn(() => revisionScope),
      closeAndTerminateDirectScope: jest.fn(() => Promise.reject(directError)),
      terminateScopeTree: jest.fn(() => { throw rootError; }),
    };
    const manager = new McpManager({
      configAuthority: testConfigAuthority(root), processRunner: processRunner as never, mcpProcessRootScope: {} as ManagedProcessScope,
      eventLogger: { appendEvent() {} } as never,
    });
    await manager.reconcilePersistedConfig();

    manager.closeAdmission();
    await expect(manager.cleanupForApplicationStop()).rejects.toBe(rootError);

    expect(processRunner.closeAndTerminateDirectScope).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toHaveLength(1);
  });

  it('starts runtime direct containment in the App admission phase before MCP cleanup begins', async () => {
    const root = projectRoot();
    writeConfig(root, { one: http('http://localhost/one') });
    const { manager, processRunner } = createManager(root);
    await manager.reconcilePersistedConfig();
    const events: string[] = [];
    const directImplementation = processRunner.closeAndTerminateDirectScope.bind(processRunner);
    jest.spyOn(processRunner, 'closeAndTerminateDirectScope').mockImplementation((input) => {
      events.push('direct-containment');
      return directImplementation(input);
    });
    const terminal = createAppTerminalCoordinator();
    terminal.registerAdmissionCloser('mcp', () => manager.closeAdmission());
    terminal.registerCleanupLeaf('mcp', () => {
      events.push('cleanup');
      return manager.cleanupForApplicationStop();
    });

    await expect(terminal.stop()).resolves.toEqual({ warnings: [] });

    expect(events).toEqual(['direct-containment', 'cleanup']);
  });
});
