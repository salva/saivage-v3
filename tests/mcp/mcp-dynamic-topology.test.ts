import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import * as realFs from 'node:fs';
let publicationFault = false;
let publicationFailed = false;
let readsAfterUncertainty = 0;
jest.unstable_mockModule('node:fs', () => ({
  ...realFs,
  readFileSync: (...args: Parameters<typeof realFs.readFileSync>) => {
    if (publicationFailed) readsAfterUncertainty++;
    return realFs.readFileSync(...args);
  },
  renameSync: (from: string, to: string) => {
    if (publicationFault && to.endsWith('/mcp-servers.json')) {
      publicationFailed = true;
      throw new Error('injected rename uncertainty');
    }
    realFs.renameSync(from, to);
  },
}));
const { McpManager } = await import('../../src/mcp/mcp-manager.js');
const { McpServerRuntime } = await import('../../src/mcp/server-runtime.js');
const { readMcpServerDefinitions, mcpServerDefinitionsPath } =
  await import('../../src/mcp/server-definitions.js');
const { ProcessRunner } = await import('../../src/runtime/process-runner.js');
const { ManagedProcessGroupRegistry } =
  await import('../../src/runtime/managed-process-group-registry.js');
const { testApplicationFatalPort } = await import('../helpers/test-application-fatal-port.js');
const { testConfigAuthority } = await import('../helpers/canonical-project.js');
const { TEST_SAIVAGE_CONFIG } = await import('../helpers/test-saivage-config.js');
const { PublicationOutcomeUnknownError } = await import('../../src/contracts/index.js');
const { createServer, listen, closeServer, readJsonRequest } =
  await import('../helpers/production-composition-e2e.js');

const roots: string[] = [];
afterEach(() => {
  publicationFault = false;
  publicationFailed = false;
  readsAfterUncertainty = 0;
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(operator = {}) {
  const root = mkdtempSync('/home/salva/g/ml/tmp/mcp-topology-');
  roots.push(root);
  mkdirSync(join(root, '.saivage'));
  writeFileSync(
    join(root, '.saivage/saivage.yaml'),
    YAML.stringify({ ...structuredClone(TEST_SAIVAGE_CONFIG), mcpServers: operator }),
  );
  const registry = new ManagedProcessGroupRegistry();
  const scope = registry.createContainerScope(registry.rootScope, 'mcp');
  const runner = new ProcessRunner(root, registry, testApplicationFatalPort);
  const events = { appendEventPrepared: jest.fn() };
  const manager = new McpManager({
    configAuthority: testConfigAuthority(root),
    processRunner: runner,
    mcpProcessRootScope: scope,
    eventLogger: events as never,
  });
  return { root, runner, manager, events };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const connection = { transport: 'streamable-http' as const, url: 'http://localhost/mcp' };

describe('dynamic MCP exact definitions and owner fences', () => {
  it('strictly reads the lazy exact family and preserves unrelated definitions and YAML', async () => {
    const { root, manager } = setup({ operator: { ...connection, autostart: false } });
    const yaml = readFileSync(join(root, '.saivage/saivage.yaml'));
    expect(readMcpServerDefinitions(root)).toEqual({});
    manager.registerServer('one', connection);
    manager.registerServer('two', connection);
    await manager.unregisterServer('one');
    expect(readMcpServerDefinitions(root)).toEqual({ two: connection });
    expect(JSON.parse(readFileSync(mcpServerDefinitionsPath(root), 'utf8'))).toEqual({
      format_version: 1,
      type: 'mcp-server-definitions',
      servers: { two: connection },
    });
    expect(readFileSync(join(root, '.saivage/saivage.yaml'))).toEqual(yaml);
    expect(() => manager.registerServer('two', connection)).toThrow('already');
    expect(() => manager.registerServer('operator', connection)).toThrow('already');
    await expect(manager.unregisterServer('operator')).rejects.toThrow('agent-owned');
    await expect(manager.unregisterServer('missing')).rejects.toThrow('agent-owned');
    for (const value of [
      '{secret',
      { format_version: 2, type: 'mcp-server-definitions', servers: {} },
      { format_version: 1, type: 'wrong', servers: {} },
      {
        format_version: 1,
        type: 'mcp-server-definitions',
        servers: { one: { ...connection, autostart: true } },
      },
    ]) {
      writeFileSync(
        mcpServerDefinitionsPath(root),
        typeof value === 'string' ? value : JSON.stringify(value),
      );
      expect(() => readMcpServerDefinitions(root)).toThrow('Invalid MCP');
    }
  });

  it.each(['register', 'unregister'] as const)(
    '%s publication uncertainty reaches the caller before further reads, status, logs, results or containment',
    async (operation) => {
      const { manager, events, runner } = setup();
      manager.registerServer('one', connection);
      await manager.reconcilePersistedConfig(); // Establish an exact retained owner without launching.
      // Deterministic primitive fault, not an E2E or a simulated successful publication.
      publicationFault = true;
      const stop = jest.spyOn(McpServerRuntime.prototype, 'stop');
      const status = jest.spyOn(manager, 'getStatus');
      const terminate = jest.spyOn(runner, 'closeAndTerminateDirectScope');
      if (operation === 'unregister')
        await expect(manager.unregisterServer('one')).rejects.toBeInstanceOf(
          PublicationOutcomeUnknownError,
        );
      else
        expect(() => manager.registerServer('two', connection)).toThrow(
          PublicationOutcomeUnknownError,
        );
      expect(stop).not.toHaveBeenCalled();
      expect(terminate).not.toHaveBeenCalled();
      expect(status).not.toHaveBeenCalled();
      expect(events.appendEventPrepared).not.toHaveBeenCalled();
      expect(readsAfterUncertainty).toBe(0);
    },
  );

  it('strict startup rejects cross-source collisions without entering any runtime', async () => {
    const { root, manager } = setup({ one: { ...connection, autostart: true } });
    mkdirSync(join(root, '.saivage/config'));
    writeFileSync(
      mcpServerDefinitionsPath(root),
      JSON.stringify({
        format_version: 1,
        type: 'mcp-server-definitions',
        servers: { one: connection },
      }),
    );
    const start = jest.spyOn(McpServerRuntime.prototype, 'start');
    await expect(manager.reconcilePersistedConfig()).rejects.toThrow('conflicting');
    expect(start).not.toHaveBeenCalled();
    await manager.cleanupForApplicationStop();
    rmSync(mcpServerDefinitionsPath(root));
    mkdirSync(mcpServerDefinitionsPath(root));
    expect(() => readMcpServerDefinitions(root)).toThrow(); // EISDIR is not lazy absence.
  });

  it.each(['startup', 'call'] as const)(
    'successful removal joins old %s; later explicit owner cannot be deleted by old completion',
    async (phase) => {
      const { manager } = setup();
      manager.registerServer('one', connection);
      manager.registerServer('other', connection);
      const original = globalThis.fetch;
      const entered = deferred();
      const release = deferred();
      let hold = true;
      let callCount = 0;
      globalThis.fetch = jest.fn(async (_url, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body));
        if (request.method === 'initialize' && phase === 'startup' && hold) {
          entered.resolve();
          await release.promise;
          init!.signal!.throwIfAborted();
        }
        if (request.method === 'notifications/initialized')
          return new Response(null, { status: 202 });
        if (request.method === 'tools/call') {
          callCount++;
          if (phase === 'call' && hold) {
            entered.resolve();
            await release.promise;
            init!.signal!.throwIfAborted();
          }
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result:
              request.method === 'tools/list'
                ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
                : request.method === 'tools/call'
                  ? { content: [] }
                  : {},
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch;
      try {
        hold = false;
        await manager.startServer('other');
        hold = true;
        const start = manager.startServer('one').catch((e) => e);
        if (phase === 'call') await start;
        const oldBinding = manager.getServerStatus('one')!.bindingId!;
        const work =
          phase === 'startup'
            ? start
            : manager.invokeTool('one', oldBinding, 'ping', {}).catch((e) => e);
        await entered.promise;
        const removal = manager.unregisterServer('one');
        expect(() => manager.registerServer('one', connection)).toThrow('containment');
        hold = false;
        release.resolve();
        await work;
        await removal;
        manager.registerServer('one', connection);
        await manager.startServer('one');
        expect(manager.getServerStatus('one')).toMatchObject({
          status: 'running',
          definitionSource: 'agent',
        });
        expect(manager.getServerStatus('one')!.bindingId).not.toBe(oldBinding);
        await expect(manager.invokeTool('one', oldBinding, 'ping', {})).rejects.toThrow('Stale');
        await manager.invokeTool('other', manager.getServerStatus('other')!.bindingId!, 'ping', {});
        expect(callCount).toBe(phase === 'call' ? 2 : 1);
      } finally {
        release.resolve();
        globalThis.fetch = original;
        await manager.cleanupForApplicationStop();
      }
    },
  );

  it('a delayed old unregister completion cannot erase a newly registered ready owner after proven containment', async () => {
    const { manager } = setup();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async (_url, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result:
            request.method === 'tools/list'
              ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
              : request.method === 'tools/call'
                ? { content: [] }
                : {},
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const contained = deferred();
    const completion = deferred();
    const realStop = McpServerRuntime.prototype.stop;
    try {
      manager.registerServer('one', connection);
      await manager.startServer('one');
      const a = manager.getServerStatus('one')!.bindingId;
      let delay = true;
      jest.spyOn(McpServerRuntime.prototype, 'stop').mockImplementation(async function (
        this: InstanceType<typeof McpServerRuntime>,
      ) {
        await realStop.call(this);
        if (delay) {
          delay = false;
          contained.resolve();
          await completion.promise;
        }
      });
      const removal = manager.unregisterServer('one');
      await contained.promise;
      manager.registerServer('one', connection);
      await manager.startServer('one');
      const b = manager.getServerStatus('one')!.bindingId!;
      expect(b).not.toBe(a);
      completion.resolve();
      await expect(removal).resolves.toEqual({
        serverName: 'one',
        unregistered: true,
        status: 'stopped',
      });
      expect(manager.getServerStatus('one')).toMatchObject({
        bindingId: b,
        definitionSource: 'agent',
        status: 'running',
      });
      await manager.invokeTool('one', b, 'ping', {});
    } finally {
      completion.resolve();
      globalThis.fetch = originalFetch;
      await manager.cleanupForApplicationStop();
    }
  });

  it.each(['startup', 'call'] as const)(
    'unregister fences entered %s before awaiting and retains failed containment',
    async (phase) => {
      const { root, manager, runner } = setup();
      manager.registerServer('one', connection);
      const original = globalThis.fetch;
      const entered = deferred();
      const release = deferred();
      globalThis.fetch = jest.fn(async (_url, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === 'initialize' && phase === 'startup') {
          entered.resolve();
          await release.promise;
          init!.signal!.throwIfAborted();
        }
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
        if (body.method === 'tools/call') {
          entered.resolve();
          await release.promise;
          init!.signal!.throwIfAborted();
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result:
              body.method === 'tools/list'
                ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
                : {},
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch;
      try {
        const start = manager.startServer('one').catch((e) => e);
        if (phase === 'call') await start;
        const work =
          phase === 'startup'
            ? start
            : manager
                .invokeTool('one', manager.getServerStatus('one')!.bindingId!, 'ping', {})
                .catch((e) => e);
        await entered.promise;
        if (phase === 'startup') {
          expect(manager.getServerStatus('one')).toMatchObject({ status: 'starting' });
          expect(manager.getServerTools('one')).toBeUndefined();
        }
        const failure = new Error('deterministic containment failure');
        jest.spyOn(runner, 'closeAndTerminateDirectScope').mockRejectedValue(failure);
        const removal = manager.unregisterServer('one').catch((e) => e);
        expect(readMcpServerDefinitions(root)).toEqual({});
        expect(() => manager.registerServer('one', connection)).toThrow('containment');
        await expect(manager.startServer('one')).rejects.toMatchObject({ statusCode: 404 });
        release.resolve();
        await work;
        expect(await removal).toBe(failure);
        expect(manager.getServerStatus('one')).toMatchObject({
          definitionSource: null,
          status: 'error',
          containmentFailed: true,
        });
        expect(() => manager.registerServer('one', connection)).toThrow('containment');
      } finally {
        release.resolve();
        globalThis.fetch = original;
      }
    },
  );

  it('fresh runtime binding rejects A with zero wire calls to identical B; restart preserves stopped dynamic definitions and YAML autostart', async () => {
    const calls: unknown[] = [];
    const peer = createServer(async (req, res) => {
      const body = await readJsonRequest(req);
      if (body.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (body.method === 'tools/call') calls.push(body.params);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result:
            body.method === 'tools/list'
              ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
              : body.method === 'tools/call'
                ? { content: [{ type: 'text', text: 'pong' }] }
                : { protocolVersion: '2025-06-18' },
        }),
      );
    });
    const port = await listen(peer);
    const config = { ...connection, url: `http://127.0.0.1:${port}` };
    const { root, manager } = setup({ operator: { ...config, autostart: true } });
    try {
      manager.registerServer('one', config);
      await manager.reconcilePersistedConfig();
      expect(manager.getServerStatus('one')).toMatchObject({
        status: 'stopped',
        bindingId: expect.any(String),
      });
      await manager.startServer('one');
      const a = manager.getServerStatus('one')!.bindingId!;
      await manager.unregisterServer('one');
      manager.registerServer('one', config);
      await manager.startServer('one');
      const b = manager.getServerStatus('one')!.bindingId!;
      expect(b).not.toBe(a);
      await expect(manager.invokeTool('one', a, 'ping', {})).rejects.toThrow('Stale MCP binding');
      expect(calls).toEqual([]);
      await manager.invokeTool('one', b, 'ping', {});
      expect(calls).toHaveLength(1);
      await manager.invokeTool(
        'operator',
        manager.getServerStatus('operator')!.bindingId!,
        'ping',
        {},
      );
      expect(calls).toHaveLength(2);
      await manager.cleanupForApplicationStop();
      const registry = new ManagedProcessGroupRegistry();
      const runner = new ProcessRunner(root, registry, testApplicationFatalPort);
      const fresh = new McpManager({
        configAuthority: testConfigAuthority(root),
        processRunner: runner,
        mcpProcessRootScope: registry.createContainerScope(registry.rootScope, 'fresh'),
        eventLogger: { appendEventPrepared() {} } as never,
      });
      try {
        await fresh.reconcilePersistedConfig();
        expect(fresh.getServerStatus('one')).toMatchObject({ status: 'stopped', processId: null });
        expect(fresh.getServerStatus('operator')).toMatchObject({ status: 'running' });
        expect(calls).toHaveLength(2);
      } finally {
        await fresh.cleanupForApplicationStop();
      }
      expect(peer.listening).toBe(true);
    } finally {
      await manager.cleanupForApplicationStop();
      await closeServer(peer);
    }
  });
});
