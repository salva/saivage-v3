import { expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
let forbidden: string[] = [];
let checking = false;
let observedReads: string[] | undefined;
jest.unstable_mockModule('node:fs', () => ({
  ...fs,
  readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    observedReads?.push(String(args[0]));
    if (checking && forbidden.some(path => String(args[0]).startsWith(path))) throw new Error('Forbidden sibling/orphan/descendant read');
    return fs.readFileSync(...args);
  },
  readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
    if (checking) throw new Error('Scope admission must not enumerate');
    return fs.readdirSync(...args);
  },
}));
const { CardService, initProjectTree } = await import('../helpers/canonical-project.js');
const { cardNamespace, cardHeadFile } = await import('../../src/persistence/layout.js');
const { McpManager, MCP_OPERATOR_CALLER, MCP_OPERATIONS } = await import('../../src/mcp/manager-api.js');
const { ProcessRunner, ManagedProcessGroupRegistry } = await import('../../src/runtime/runtime-api.js');
const { testApplicationFatalPort } = await import('../helpers/test-application-fatal-port.js');
const { createTestConfigAuthority } = await import('../helpers/project-config.js');
const { mcpServerDefinitionsPath, readMcpServerDefinitions, replaceMcpServerDefinitions } = await import('../../src/mcp/server-definitions.js');
const { TEST_SAIVAGE_CONFIG } = await import('../helpers/test-saivage-config.js');
const YAML = await import('yaml');

function measuredFixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'mcp-local-selection-'));
  initProjectTree(root);
  const cards = new CardService(root);
  const a = cards.create({ parent: 'project', type: 'goal', title: 'A', bootstrap_content: 'Exact A.', created_by: 'analyst', depends_on: [] }).id;
  const b = cards.create({ parent: 'project', type: 'goal', title: 'B', bootstrap_content: 'Exact B.', created_by: 'analyst', depends_on: [] }).id;
  const groups = new ManagedProcessGroupRegistry();
  const authority = createTestConfigAuthority(root);
  const paths = jest.fn((id: string) => cards.readCanonicalLivePath(id));
  const named = jest.spyOn(Object.getPrototypeOf(authority) as typeof authority, 'loadMcpServer');
  const collection = jest.spyOn(Object.getPrototypeOf(authority) as typeof authority, 'loadMcpServers');
  const manager = new McpManager({ nativeGit: false, readCanonicalLivePath: paths,
    processRunner: new ProcessRunner(root, groups, testApplicationFatalPort), configAuthority: authority,
    mcpProcessRootScope: groups.createContainerScope(groups.rootScope, 'mcp'), eventLogger: { appendEventPrepared() {} } as never });
  const caller = { principal: { kind: 'card' as const, cardId: 'project' }, operations: MCP_OPERATIONS };
  const connection = { transport: 'stdio' as const, command: process.execPath };
  const reset = () => { named.mockClear(); collection.mockClear(); paths.mockClear(); observedReads = []; };
  const expectDecision = (ids: string[], name?: string) => {
    expect(observedReads!.filter(path => path === mcpServerDefinitionsPath(root))).toHaveLength(1);
    expect(observedReads!.filter(path => path === join(root, '.saivage/config/files-test.yaml'))).toHaveLength(1);
    expect(named.mock.calls).toEqual(name === undefined ? [] : [[name]]);
    expect(collection).toHaveBeenCalledTimes(name === undefined ? 1 : 0);
    expect(paths.mock.calls.map(([id]) => id).sort()).toEqual([...ids].sort());
  };
  const close = async () => {
    observedReads = undefined;
    named.mockRestore(); collection.mockRestore();
    await manager.cleanupForApplicationStop();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, cards, a, b, manager, authority, caller, connection, paths, named, collection, reset, expectDecision, close };
}

it('bounds collection/exact definition and exact-path consumption, keeping every call fresh and unusual names exact', async () => {
  const f = measuredFixture();
  try {
    for (const name of ['one', 'two', '__proto__', 'constructor'])
      f.manager.registerServer(MCP_OPERATOR_CALLER, name, f.connection, { controllerCardId: f.a, exposure: 'card' });
    for (let i = 0; i < 2; i++) {
      f.reset();
      const statuses = f.manager.getStatus(f.caller);
      expect(statuses).toHaveLength(4);
      expect(statuses.every(status => status.availableActions.length === 5 && !('tools_count' in status))).toBe(true);
      f.expectDecision([f.a]);
    }
    for (const name of ['one', '__proto__', 'constructor']) {
      f.reset();
      expect(f.manager.getServerStatus(f.caller, name)?.name).toBe(name);
      f.expectDecision([f.a], name);
    }
    f.manager.setServerScope(f.caller, 'one', { controllerCardId: f.a, exposure: 'subtree' });
    f.manager.setServerScope(f.caller, 'two', { controllerCardId: f.b, exposure: 'subtree' });
    f.reset();
    expect(f.manager.getStatus(f.caller)).toHaveLength(4);
    f.expectDecision([f.a, f.b, 'project']);
    f.reset();
    expect(f.manager.getServerStatus(f.caller, 'missing')).toBeUndefined();
    f.expectDecision([], 'missing');
    f.reset();
    expect(() => f.manager.getServerStatus({ ...f.caller, operations: [] }, 'one')).toThrow('unavailable');
    expect(observedReads).toEqual([]);
    expect(f.paths).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('does not consume irrelevant caller paths and reads again at each real tool dispatch fence', async () => {
  const f = measuredFixture();
  const originalFetch = globalThis.fetch;
  let dispatched = 0;
  globalThis.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const rpc = JSON.parse(String(init?.body));
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (rpc.method === 'tools/call') dispatched++;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result:
      rpc.method === 'initialize' ? { protocolVersion: '2025-06-18' } :
      rpc.method === 'tools/list' ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } : { content: [] },
    }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    f.manager.registerServer(f.caller, 'one', { transport: 'streamable-http', url: 'http://fixture.invalid/mcp' }, { controllerCardId: f.a, exposure: 'card' });
    const unrelated = { principal: { kind: 'card' as const, cardId: f.b }, operations: ['mcp_servers'] as const };
    f.reset();
    expect(f.manager.getServerStatus(unrelated, 'one')).toBeUndefined();
    f.expectDecision([f.a], 'one');
    f.reset();
    expect(f.manager.getServerStatus(MCP_OPERATOR_CALLER, 'one')).toHaveProperty('tools_count');
    f.expectDecision([f.a], 'one');
    const global = { principal: { kind: 'global' as const }, operations: MCP_OPERATIONS };
    f.reset();
    expect(f.manager.getServerStatus(global, 'one')).toHaveProperty('tools_count');
    f.expectDecision([f.a], 'one');
    f.reset();
    const boundaries: Array<{ reads: number; paths: number }> = [];
    // Preserve the real configuration owner while recording decision boundaries.
    const actualLoad = f.named.getMockImplementation()!;
    f.named.mockImplementation(name => {
      boundaries.push({ reads: observedReads!.length, paths: f.paths.mock.calls.length });
      return actualLoad.call(f.authority, name);
    });
    const expectFences = (hasResultProjection: boolean) => {
      expect(boundaries.length).toBeGreaterThanOrEqual(2); // Admission and actual dispatch are independent.
      const ends = [...boundaries.slice(1), { reads: observedReads!.length, paths: f.paths.mock.calls.length }];
      boundaries.forEach((start, i) => {
        const reads = observedReads!.slice(start.reads, ends[i]!.reads);
        expect(reads.filter(path => path === mcpServerDefinitionsPath(f.root))).toHaveLength(1);
        expect(reads.filter(path => path === join(f.root, '.saivage/config/files-test.yaml'))).toHaveLength(1);
        const resultProjection = hasResultProjection && i === boundaries.length - 1;
        expect(f.paths.mock.calls.slice(start.paths, ends[i]!.paths)).toEqual(resultProjection ? [] : [[f.a]]);
      });
      expect(f.collection).not.toHaveBeenCalled();
    };
    await f.manager.startServer(global, 'one');
    expectFences(true);
    const catalog = f.manager.getServerCatalog(global, 'one')!;
    f.reset(); boundaries.length = 0;
    await f.manager.invokeTool(global, 'one', catalog.bindingId, catalog.catalogId, 'ping', {});
    expect(dispatched).toBe(1);
    expectFences(false);
    f.reset(); boundaries.length = 0;
    await f.manager.refreshServerCatalog(global, 'one', catalog.bindingId);
    expectFences(true);
    f.reset(); boundaries.length = 0;
    await f.manager.stopServer(global, 'one');
    f.expectDecision([f.a], 'one');
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

it('reads one selection for synchronous publications and shares only identical old/destination paths', async () => {
  const f = measuredFixture();
  try {
    f.reset();
    f.manager.registerServer(f.caller, 'one', f.connection, { controllerCardId: f.a, exposure: 'subtree' });
    f.expectDecision([f.a], 'one');
    f.manager.registerServer(f.caller, 'other', f.connection, { controllerCardId: f.b, exposure: 'card' });
    const neighbor = readMcpServerDefinitions(f.root).other;
    f.reset();
    f.manager.replaceServer(f.caller, 'one', { ...f.connection, args: ['replacement'] });
    f.expectDecision([f.a], 'one');
    f.reset();
    f.manager.setServerScope(f.caller, 'one', { controllerCardId: f.a, exposure: 'card' });
    f.expectDecision([f.a], 'one');
    f.reset();
    f.manager.setServerScope(f.caller, 'one', { controllerCardId: f.b, exposure: 'subtree' });
    f.expectDecision([f.a, f.b], 'one');
    f.reset();
    await f.manager.unregisterServer(f.caller, 'one');
    f.expectDecision([f.b], 'one');
    expect(readMcpServerDefinitions(f.root)).toEqual({ other: neighbor });
  } finally { await f.close(); }
});

it('isolates exact status authority paths but keeps whole dynamic and selected YAML validation strict', async () => {
  const f = measuredFixture();
  try {
    f.manager.registerServer(f.caller, 'one', f.connection, { controllerCardId: f.a, exposure: 'card' });
    f.manager.registerServer(f.caller, 'two', f.connection, { controllerCardId: f.b, exposure: 'card' });
    const head = fs.readFileSync(cardHeadFile(f.root, f.b));
    fs.writeFileSync(cardHeadFile(f.root, f.b), 'malformed reached head\n');
    f.reset();
    expect(f.manager.getServerStatus(f.caller, 'one')?.name).toBe('one');
    f.expectDecision([f.a], 'one');
    expect(() => f.manager.getStatus(f.caller)).toThrow();
    fs.writeFileSync(cardHeadFile(f.root, f.b), head);
    const definitions = readMcpServerDefinitions(f.root);
    fs.writeFileSync(mcpServerDefinitionsPath(f.root), JSON.stringify({ format_version: 2, type: 'mcp-server-definitions', servers: { ...definitions, two: { invalid: true } } }));
    expect(() => f.manager.getServerStatus(f.caller, 'one')).toThrow('contract');
    replaceMcpServerDefinitions(f.root, definitions);
    const yamlPath = join(f.root, '.saivage/config/files-test.yaml');
    fs.writeFileSync(yamlPath, YAML.stringify({ ...TEST_SAIVAGE_CONFIG, mcpServers: { bad: { transport: 'stdio' } } }));
    expect(f.manager.getServerStatus(f.caller, 'one')?.name).toBe('one');
    expect(() => f.manager.getServerStatus(f.caller, 'bad')).toThrow();
    expect(() => f.manager.getStatus(f.caller)).toThrow();
    fs.writeFileSync(yamlPath, YAML.stringify({ ...TEST_SAIVAGE_CONFIG, mcpServers: { one: { ...f.connection, format_version: 1, policy: definitions.one!.policy } } }));
    expect(() => f.manager.getServerStatus(f.caller, 'one')).toThrow('conflicting');
  } finally { await f.close(); }
});

it('uses only committed exact paths despite reordered siblings, poisoned unlinked prefixes and a tombstoned ancestor', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'mcp-canonical-path-'));
  initProjectTree(root);
  const cards = new CardService(root);
  const create = (parent: string, type: 'goal' | 'code') => cards.create({ parent, type, title: 'Exact path', bootstrap_content: 'Canonical scope fixture.', created_by: 'analyst', depends_on: [] }).id;
  const a = create('project', 'goal'), b = create('project', 'goal'), child = create(a, 'code');
  const orphan = `${a}-z`;
  fs.mkdirSync(cardNamespace(root, orphan), { recursive: true });
  fs.writeFileSync(cardHeadFile(root, orphan), 'poisoned unlinked canonical-looking head');
  const groups = new ManagedProcessGroupRegistry();
  const runner = new ProcessRunner(root, groups, testApplicationFatalPort);
  const manager = new McpManager({ nativeGit: false, readCanonicalLivePath: id => cards.readCanonicalLivePath(id),
    processRunner: runner, configAuthority: createTestConfigAuthority(root), mcpProcessRootScope: groups.createContainerScope(groups.rootScope, 'mcp'), eventLogger: { appendEventPrepared() {} } as never });
  const caller = { principal: { kind: 'card' as const, cardId: a }, operations: MCP_OPERATIONS };
  try {
    forbidden = [cardNamespace(root, b), cardNamespace(root, orphan)]; checking = true;
    manager.registerServer(caller, 'one', { transport: 'stdio', command: process.execPath }, { controllerCardId: child, exposure: 'subtree' });
    expect(manager.getServerStatus(caller, 'one')).toMatchObject({ policy: { controllerCardId: child } });
    expect(() => manager.registerServer(caller, 'fake', { transport: 'stdio', command: process.execPath }, { controllerCardId: orphan, exposure: 'subtree' })).toThrow('unavailable');
    checking = false; cards.reorderChildren('project', [b, a]); checking = true;
    expect(manager.getServerStatus(caller, 'one')).toMatchObject({ policy: { controllerCardId: child } });
    const selectedHead = fs.readFileSync(cardHeadFile(root, child));
    fs.writeFileSync(cardHeadFile(root, child), 'complete malformed selected head\n');
    try {
      expect(() => manager.getServerStatus(caller, 'one')).toThrow();
      try { manager.getServerStatus(caller, 'one'); } catch (error) {
        expect((error as Error).message).not.toContain('MCP server unavailable');
      }
    } finally { fs.writeFileSync(cardHeadFile(root, child), selectedHead); }
    checking = false; cards.deleteSubtrees([a], () => true, 'analyst');
    forbidden.push(cardNamespace(root, child)); checking = true;
    expect(manager.getServerStatus(MCP_OPERATOR_CALLER, 'one')).toMatchObject({ ready: false, policy: { controllerCardId: child } });
    expect(() => manager.getServerCatalog(MCP_OPERATOR_CALLER, 'one')).toThrow('unavailable');
    manager.setServerScope(MCP_OPERATOR_CALLER, 'one', { controllerCardId: 'project', exposure: 'subtree' });
  } finally { checking = false; forbidden = []; await manager.cleanupForApplicationStop(); fs.rmSync(root, { recursive: true, force: true }); }
});
