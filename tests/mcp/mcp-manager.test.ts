import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as YAML from 'yaml';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import { issueCompositionMutationAuthority } from '../../src/application/mutation-authority.js';
import { ManagedProcessGroupRegistry, type ManagedProcessPlatform } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { testConfigAuthority } from '../helpers/canonical-project.js';

const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-mcp-reconcile-'));
  roots.push(root);
  return root;
}

function baseConfig(mcpServers: Record<string, unknown>): Record<string, unknown> {
  return {
    server: { port: 8080, host: '127.0.0.1' },
    models: { default: ['test-model'] },
    providers: { test: { priority: 10, models: ['test-model'], apiKey: 'synthetic-secret' } },
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
  const processRunner = new ProcessRunner(root, new ManagedProcessGroupRegistry(platform));
  return { manager: new McpManager({ configAuthority: testConfigAuthority(root), processRunner }), spawn, signal };
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

    const invocation = manager.invokeTool(issueCompositionMutationAuthority(), 'one', 'ping', {});
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
    const { manager, signal } = createManager(root);
    const before = await manager.reconcilePersistedConfig();
    writeFileSync(join(root, '.saivage', 'saivage.yaml'), 'mcpServers: invalid\n');

    await expect(manager.reconcilePersistedConfig()).rejects.toThrow();
    expect(signal).not.toHaveBeenCalled();
    expect(manager.getStatus()[0]?.status).toBe('running');
    expect(before.active[0]?.revision).toBeDefined();
  });

  it('closes manager admission synchronously and terminally contains retained runtimes', async () => {
    const root = projectRoot();
    writeConfig(root, { one: stdio('one') });
    const { manager, signal } = createManager(root);
    await manager.reconcilePersistedConfig();

    manager.closeAdmission();
    await expect(manager.reconcilePersistedConfig()).rejects.toThrow('closed');
    await manager.dispose();

    expect(signal).toHaveBeenCalled();
    expect(manager.getStatus()).toEqual([]);
  });
});
