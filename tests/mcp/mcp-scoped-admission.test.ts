import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as YAML from 'yaml';
import { McpManager, MCP_OPERATIONS, MCP_OPERATOR_CALLER, type McpCaller } from '../../src/mcp/manager-api.js';
import { ProcessRunner, ManagedProcessGroupRegistry } from '../../src/runtime/runtime-api.js';
import { BoundAgentToolSet, resolveRuntimeTool, invokeToolForLlm } from '../../src/tools/tool-api.js';
import { CardService, initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';
import { readMcpServerDefinitions, replaceMcpServerDefinitions, mcpServerDefinitionsPath } from '../../src/mcp/server-definitions.js';
import { agentCapabilitiesSchema, mcpServerEntrySchema } from '../../src/schemas/index.js';
import { deferred } from '../../src/runtime/actors/deferred.js';
import { createServer, listen, closeServer, readJsonRequest } from '../helpers/production-composition-e2e.js';
import Fastify from 'fastify';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { McpLifecycleIngress } from '../../src/server/composition/mcp-lifecycle-ingress.js';
import { buildMcpOperatorContractHandlers } from '../../src/server/routes/operator-mcp-handlers.js';
import { mcpOperatorApiContracts } from '../../src/contracts/operator-api-mcp.js';
import { WorkGcBusyError } from '../../src/contracts/work-gc.js';

const roots: string[] = [];
const managers: McpManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.cleanupForApplicationStop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const cardCaller = (cardId: string, operations: McpCaller['operations'] = MCP_OPERATIONS): McpCaller => ({
  principal: { kind: 'card', cardId }, operations,
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-scoped-'));
  roots.push(root);
  initProjectTree(root);
  writeFileSync(join(root, '.saivage', 'saivage.yaml'), YAML.stringify(TEST_SAIVAGE_CONFIG));
  const cards = new CardService(root);
  const create = (parent: string, type: 'goal' | 'code') => cards.create({
    parent, type, title: 'Scoped MCP fixture', bootstrap_content: 'Exercise exact MCP admission.',
    created_by: 'analyst', depends_on: [],
  });
  const a = create('project', 'goal');
  const b = create('project', 'goal');
  const child = create(a.id, 'code');
  const groups = new ManagedProcessGroupRegistry();
  const runner = new ProcessRunner(root, groups, testApplicationFatalPort);
  const manager = new McpManager({
    nativeGit: false, readCanonicalLivePath: (id) => cards.readCanonicalLivePath(id),
    configAuthority: testConfigAuthority(root), processRunner: runner,
    mcpProcessRootScope: groups.createContainerScope(groups.rootScope, 'mcp'),
    eventLogger: { appendEventPrepared() {} } as never,
  });
  managers.push(manager);
  const surface = (cardId: string, names: string[]) => new BoundAgentToolSet(
    names.map((name) => resolveRuntimeTool('card', name)),
  ).bind({ scope: 'card', cardId, projectRoot: root, agentName: 'executor',
    store: cards, processRunner: runner, mcpToolInvocation: manager } as never);
  const call = async (cardId: string, name: string, args: unknown, names = [name]) => {
    const result = await invokeToolForLlm(surface(cardId, names), name, args,
      testLlmToolInvocationContext({ sessionId: `agent:executor:${cardId}`, toolName: name }));
    return result.kind === 'executed' ? result.execution.providerOutcome : result.providerOutcome;
  };
  return { root, cards, manager, runner, a, b, child, call };
}
const peer = String.raw`
const fs = require('node:fs');
let count=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const req=JSON.parse(line); if(req.id===undefined) return;
 const send=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');
 if(req.method==='initialize') return send({protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
 if(req.method==='tools/list') return send({tools:[{name:'count',inputSchema:{type:'object'}}]});
 if(req.method==='tools/call') {
  const value=++count, args=req.params.arguments;
  if(args.block) {
   const watcher=fs.watch(args.release,()=>{watcher.close();send({content:[{type:'text',text:String(value)}]});});
   fs.writeFileSync(args.entered,'entered');
  } else send({content:[{type:'text',text:String(value)}]});
 }
});`;
const connection = { transport: 'stdio' as const, command: process.execPath, args: ['-e', peer] };

describe('scoped MCP production admission', () => {
  it('routes authenticated strict operator scope changes through real admission, refuses YAML and GC busy', async () => {
    const { root, manager, a } = setup();
    manager.registerServer(cardCaller(a.id), 'dynamic', connection);
    writeFileSync(join(root, '.saivage', 'saivage.yaml'), YAML.stringify({ ...TEST_SAIVAGE_CONFIG,
      mcpServers: { operator: { ...connection, format_version: 1, policy: { controllerCardId: 'project', exposure: 'subtree' }, autostart: false } },
    }));
    let busy = false;
    const ingress = new McpLifecycleIngress(manager, () => { if (busy) throw new WorkGcBusyError(); }, testApplicationFatalPort);
    const server = Fastify({ logger: false });
    new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'operator-fixture' }), eventLogger: { appendEventPrepared() {} } as never, fatalPort: testApplicationFatalPort })
      .mount(server, mcpOperatorApiContracts, buildMcpOperatorContractHandlers({ mcpToolsProvider: manager, mcpLifecycle: ingress }));
    const payload = { policy: { controllerCardId: 'project', exposure: 'subtree' } };
    const headers = { authorization: 'Bearer operator-fixture' };
    try {
      const url = '/api/mcp/servers/dynamic/scope';
      expect((await server.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
      expect(readMcpServerDefinitions(root).dynamic!.policy.controllerCardId).toBe(a.id);
      expect((await server.inject({ method: 'POST', url, headers, payload: { ...payload, caller: 'project' } })).statusCode).toBe(400);
      busy = true;
      expect((await server.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(409);
      expect(readMcpServerDefinitions(root).dynamic!.policy.controllerCardId).toBe(a.id);
      busy = false;
      const response = await server.inject({ method: 'POST', url, headers, payload });
      expect(response.statusCode).toBe(200);
      expect(mcpOperatorApiContracts['mcp.scope'].success.parse(response.json())).toEqual({ serverName: 'dynamic', ...payload, updated: true });
      expect((await server.inject({ method: 'POST', url: '/api/mcp/servers/operator/scope', headers, payload })).statusCode).toBe(404);
      expect(ingress.hasActiveLifecycleCall()).toBe(false);
    } finally { await server.close(); }
  });
  it.each(['next page', 'publication'] as const)('fences HTTP %s and post-stop restart continuation against fresh policy', async boundary => {
    const { manager, runner, a, b } = setup();
    let listing = 0, calls = 0;
    const pageEntered = deferred<void>(), pageRelease = deferred<void>();
    const callEntered = deferred<void>(), callRelease = deferred<void>();
    const peer = createServer(async (req, res) => {
      const rpc = await readJsonRequest(req);
      if (rpc.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
      if (rpc.method === 'tools/list' && ++listing === 2) { pageEntered.resolve(); await pageRelease.promise; }
      if (rpc.method === 'tools/call') { calls++; callEntered.resolve(); await callRelease.promise; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'initialize' ? { protocolVersion: '2025-06-18' } : rpc.method === 'tools/list' ? { tools: [{ name: 'count', inputSchema: { type: 'object' } }], ...(listing === 2 && boundary === 'next page' ? { nextCursor: 'revoked-page' } : {}) } : { content: [{ type: 'text', text: String(calls) }] } }));
    });
    const port = await listen(peer);
    const global: McpCaller = { principal: { kind: 'global' }, operations: MCP_OPERATIONS };
    try {
      manager.registerServer(cardCaller(a.id), 'http', { transport: 'streamable-http', url: `http://127.0.0.1:${port}` });
      await manager.startServer(cardCaller(a.id), 'http');
      const catalog = manager.getServerCatalog(cardCaller(a.id), 'http')!;
      const refresh = manager.refreshServerCatalog(cardCaller(a.id), 'http', catalog.bindingId);
      const refused = expect(refresh).rejects.toThrow('unavailable');
      await pageEntered.promise;
      manager.setServerScope(global, 'http', { controllerCardId: b.id, exposure: 'card' });
      pageRelease.resolve(); await refused;
      expect(manager.getServerCatalog(cardCaller(b.id), 'http')!.catalogId).toBe(catalog.catalogId);
      await expect(manager.invokeTool(cardCaller(a.id), 'http', catalog.bindingId, catalog.catalogId, 'count', {})).rejects.toThrow('unavailable');
      expect(calls).toBe(0);
      const dispatched = manager.invokeTool(cardCaller(b.id), 'http', catalog.bindingId, catalog.catalogId, 'count', {});
      await callEntered.promise;
      manager.setServerScope(global, 'http', { controllerCardId: a.id, exposure: 'card' });
      callRelease.resolve();
      expect(await dispatched).toMatchObject({ content: [{ text: '1' }] });
      manager.setServerScope(global, 'http', { controllerCardId: b.id, exposure: 'card' });
      const entered = deferred<void>(), release = deferred<void>();
      const actual = runner.closeAndTerminateDirectScope.bind(runner);
      const stop = jest.spyOn(runner, 'closeAndTerminateDirectScope').mockImplementation(async input => {
        const report = await actual(input); entered.resolve(); await release.promise; return report;
      });
      try {
        const restart = manager.restartServer(cardCaller(b.id), 'http');
        const revoked = expect(restart).rejects.toThrow('unavailable');
        await entered.promise;
        manager.setServerScope(global, 'http', { controllerCardId: a.id, exposure: 'subtree' });
        release.resolve(); await revoked;
        expect(listing).toBe(2); // No successor initialize/list after revocation.
        expect(manager.getServerStatus(global, 'http')).toMatchObject({ ready: false, containment: 'contained' });
      } finally { release.resolve(); stop.mockRestore(); }
    } finally { pageRelease.resolve(); callRelease.resolve(); await closeServer(peer); }
  }, 20_000);

  it('keeps stopping pending when the real leader exits with a surviving same-group child, then contains the group', async () => {
    const { root, manager, runner, a } = setup();
    const pidPath = join(root, 'worker.pid');
    const foreground = String.raw`
      const fs=require('node:fs'),cp=require('node:child_process');
      const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      fs.writeFileSync(process.argv[1],String(child.pid));
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line);if(r.id===undefined)return;
        const result=r.method==='initialize'?{protocolVersion:'2025-06-18'}:r.method==='tools/list'?{tools:[{name:'exit',inputSchema:{type:'object'}}]}:{content:[]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n',()=>{if(r.method==='tools/call')process.exit(0)});
      });`;
    const actual = runner.closeAndTerminateDirectScope.bind(runner);
    const entered = deferred<void>(), release = deferred<void>();
    const contain = jest.spyOn(runner, 'closeAndTerminateDirectScope').mockImplementation(async input => {
      entered.resolve(); await release.promise; return actual(input);
    });
    try {
      manager.registerServer(cardCaller(a.id), 'group', { transport: 'stdio', command: process.execPath, args: ['-e', foreground, pidPath] });
      await manager.startServer(cardCaller(a.id), 'group');
      const catalog = manager.getServerCatalog(cardCaller(a.id), 'group')!;
      await manager.invokeTool(cardCaller(a.id), 'group', catalog.bindingId, catalog.catalogId, 'exit', {});
      await entered.promise;
      const childPid = Number(readFileSync(pidPath, 'utf8'));
      expect(childPid).toBeGreaterThan(0);
      expect(() => process.kill(childPid, 0)).not.toThrow(); // Exact fixture child, no process scan.
      expect(manager.getServerStatus(cardCaller(a.id), 'group')).toMatchObject({ status: 'stopping', ready: false, containment: 'pending' });
      release.resolve();
      await manager.stopServer(cardCaller(a.id), 'group');
      expect(manager.getServerStatus(cardCaller(a.id), 'group')).toMatchObject({ ready: false, containment: 'contained', containmentBoundary: 'local_process_group' });
      expect(runner.list()).toEqual([]);
    } finally { release.resolve(); contain.mockRestore(); }
  }, 20_000);
  it('binds final independent grants, restricts branch use and adopts the same application-owned connection', async () => {
    const { root, manager, a, b, child, call } = setup();
    expect(await call(a.id, 'mcp_server_register', { serverName: 'peer', connection })).toMatchObject({ kind: 'succeeded' });
    expect(await call(a.id, 'mcp_server_register', { serverName: 'spoofed', connection, caller: { kind: 'global' } })).toMatchObject({ kind: 'failed' });
    expect(readMcpServerDefinitions(root).peer!.policy).toEqual({ controllerCardId: a.id, exposure: 'subtree' });
    expect(await call(a.id, 'mcp_server_control', { serverName: 'peer', action: 'start' })).toMatchObject({ kind: 'succeeded' });
    const before = manager.getServerStatus(MCP_OPERATOR_CALLER, 'peer')!;
    const catalog = manager.getServerCatalog(cardCaller(child.id, ['mcp_tools']), 'peer')!;
    expect(manager.getStatus(cardCaller(b.id, ['mcp_servers']))).toEqual([]);
    expect(() => manager.getServerCatalog(cardCaller('project'), 'peer')).toThrow('unavailable');
    expect(manager.getStatus(cardCaller('project'))[0]).not.toHaveProperty('tools_count');
    expect(await manager.startServer(cardCaller('project'), 'peer')).not.toHaveProperty('toolCount');
    expect(() => manager.getServerCatalog(cardCaller(child.id, ['mcp_tool_call']), 'peer')).toThrow('unavailable');
    await expect(manager.invokeTool(cardCaller(b.id), 'peer', catalog.bindingId, catalog.catalogId, 'count', {})).rejects.toThrow('unavailable');
    for (const controllerCardId of ['project', b.id, 'card-a-z'])
      expect(() => manager.setServerScope(cardCaller(child.id), 'peer', { controllerCardId, exposure: 'subtree' })).toThrow('unavailable');
    expect(await call('project', 'mcp_server_set_scope', { serverName: 'peer', policy: { controllerCardId: 'project', exposure: 'subtree' } })).toMatchObject({ kind: 'succeeded' });
    expect(manager.getServerStatus(MCP_OPERATOR_CALLER, 'peer')).toMatchObject({ bindingId: before.bindingId, processId: before.processId, ready: true });
    expect(manager.getServerCatalog(cardCaller('project'), 'peer')!.catalogId).toBe(catalog.catalogId);
    expect(await manager.invokeTool(cardCaller('project', ['mcp_tool_call']), 'peer', catalog.bindingId, catalog.catalogId, 'count', {})).toMatchObject({ content: [{ text: '1' }] });
    expect(await call(child.id, 'mcp_server_set_scope', { serverName: 'peer', policy: { controllerCardId: child.id, exposure: 'card' } }, ['mcp_tools'])).toMatchObject({ kind: 'failed' });
  });

  it.each(['policy', 'removed definition', 'replaced connection'] as const)('fences a queued call on fresh %s without cancelling dispatched work or changing binding/catalog', async mode => {
    const { root, manager, a, child } = setup();
    manager.registerServer(cardCaller(a.id), 'peer', connection);
    await manager.startServer(cardCaller(a.id), 'peer');
    const catalog = manager.getServerCatalog(cardCaller(a.id), 'peer')!;
    const release = join(root, 'release');
    const entered = join(root, 'entered');
    writeFileSync(release, '');
    let observe!: () => void;
    const observed = new Promise<void>((resolve) => { observe = resolve; });
    const watcher = watch(root, (_event, name) => { if (name === 'entered') observe(); });
    try {
      const first = manager.invokeTool(cardCaller(a.id), 'peer', catalog.bindingId, catalog.catalogId, 'count', { block: true, release, entered });
      await observed;
      const second = manager.invokeTool(cardCaller(child.id), 'peer', catalog.bindingId, catalog.catalogId, 'count', {});
      const rejected = expect(second).rejects.toThrow('unavailable');
      const definitions = readMcpServerDefinitions(root);
      if (mode === 'policy') manager.setServerScope(cardCaller(a.id), 'peer', { controllerCardId: a.id, exposure: 'card' });
      else if (mode === 'removed definition') replaceMcpServerDefinitions(root, {});
      else replaceMcpServerDefinitions(root, { peer: { ...definitions.peer!, connection: { ...connection, args: ['-e', peer, 'changed'] } } });
      writeFileSync(release, 'go');
      expect(await first).toMatchObject({ content: [{ text: '1' }] });
      await rejected;
      if (mode !== 'policy') replaceMcpServerDefinitions(root, definitions);
      expect(await manager.invokeTool(cardCaller(a.id), 'peer', catalog.bindingId, catalog.catalogId, 'count', {})).toMatchObject({ content: [{ text: '2' }] });
      expect(manager.getServerCatalog(cardCaller(a.id), 'peer')!.catalogId).toBe(catalog.catalogId);
    } finally { watcher.close(); }
  });

  it('projects start and refresh counts from fresh post-await exposure', async () => {
    const { manager, a, child } = setup();
    let entered = deferred<void>(), release = deferred<void>();
    const server = createServer(async (req, res) => {
      const rpc = await readJsonRequest(req);
      if (rpc.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
      if (rpc.method === 'tools/list') { entered.resolve(); await release.promise; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'initialize'
        ? { protocolVersion: '2025-06-18' }
        : { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } }));
    });
    const port = await listen(server);
    try {
      manager.registerServer(cardCaller(a.id), 'peer', { transport: 'streamable-http', url: `http://127.0.0.1:${port}` });
      const starting = manager.startServer(cardCaller(a.id), 'peer');
      await entered.promise;
      // The caller remains a manager, but is no longer in the exposure audience.
      manager.setServerScope(cardCaller(a.id), 'peer', { controllerCardId: child.id, exposure: 'card' });
      release.resolve();
      expect(await starting).toEqual({ serverName: 'peer', status: 'running' });
      const catalog = manager.getServerCatalog(cardCaller(child.id), 'peer')!;
      manager.setServerScope(cardCaller(a.id), 'peer', { controllerCardId: a.id, exposure: 'subtree' });
      entered = deferred<void>(); release = deferred<void>();
      const refreshing = manager.refreshServerCatalog(cardCaller(a.id), 'peer', catalog.bindingId);
      await entered.promise;
      manager.setServerScope(cardCaller(a.id), 'peer', { controllerCardId: child.id, exposure: 'card' });
      release.resolve();
      const result = await refreshing;
      expect(result).not.toHaveProperty('toolCount');
      expect(result.catalogId).not.toBe(catalog.catalogId);
      expect(manager.getServerCatalog(cardCaller(child.id), 'peer')!.catalogId).toBe(result.catalogId);
    } finally { release.resolve(); await closeServer(server); }
  });

  it('revokes queued stdio management refresh without stopping the prior dispatched call or publishing a catalog', async () => {
    const { root, manager, a, b, child } = setup();
    manager.registerServer(cardCaller(child.id), 'peer', connection);
    await manager.startServer(cardCaller(child.id), 'peer');
    const catalog = manager.getServerCatalog(cardCaller(child.id), 'peer')!;
    const release = join(root, 'release-refresh'), entered = join(root, 'entered-refresh');
    writeFileSync(release, '');
    const observed = deferred<void>();
    const watcher = watch(root, (_event, name) => { if (name === 'entered-refresh') observed.resolve(); });
    try {
      const first = manager.invokeTool(cardCaller(child.id), 'peer', catalog.bindingId, catalog.catalogId, 'count', { block: true, release, entered });
      await observed.promise;
      const refresh = manager.refreshServerCatalog(cardCaller(a.id), 'peer', catalog.bindingId);
      const refused = expect(refresh).rejects.toThrow('unavailable');
      manager.setServerScope(MCP_OPERATOR_CALLER, 'peer', { controllerCardId: b.id, exposure: 'card' });
      writeFileSync(release, 'go');
      expect(await first).toMatchObject({ content: [{ text: '1' }] });
      await refused;
      expect(manager.getServerCatalog(cardCaller(b.id), 'peer')!.catalogId).toBe(catalog.catalogId);
      expect(manager.getServerStatus(cardCaller(b.id), 'peer')).toMatchObject({ ready: true, containment: 'open' });
      expect(await manager.invokeTool(cardCaller(b.id), 'peer', catalog.bindingId, catalog.catalogId, 'count', {})).toMatchObject({ content: [{ text: '2' }] });
    } finally { watcher.close(); }
  });

  it('requires explicit global anchors and rejects old/mixed input contracts', () => {
    const { root, manager, a } = setup();
    const global: McpCaller = { principal: { kind: 'global' }, operations: MCP_OPERATIONS };
    expect(() => manager.registerServer(global, 'peer', connection)).toThrow('unavailable');
    manager.registerServer(global, 'peer', connection, { controllerCardId: a.id, exposure: 'card' });
    expect(JSON.parse(readFileSync(mcpServerDefinitionsPath(root), 'utf8')).format_version).toBe(2);
    expect(agentCapabilitiesSchema.safeParse({ format_version: 1, grants: [] }).success).toBe(false);
    expect(agentCapabilitiesSchema.safeParse({ format_version: 2, grants: [] }).success).toBe(true);
    expect(mcpServerEntrySchema.safeParse(connection).success).toBe(false);
    expect(mcpServerEntrySchema.safeParse({ ...connection, format_version: 1, policy: { controllerCardId: 'project', exposure: 'subtree' } }).success).toBe(true);
    writeFileSync(mcpServerDefinitionsPath(root), JSON.stringify({ format_version: 1, type: 'mcp-server-definitions', servers: {} }));
    expect(() => readMcpServerDefinitions(root)).toThrow('contract');
  });

  it('retains safe ancestor containment authority after tombstone and definition removal, with honest failed settlement', async () => {
    const { manager, runner, cards, a, b, child } = setup();
    manager.registerServer(cardCaller(child.id), 'peer', connection);
    await manager.startServer(cardCaller(child.id), 'peer');
    const actual = runner.closeAndTerminateDirectScope.bind(runner);
    const containment = jest.spyOn(runner, 'closeAndTerminateDirectScope').mockImplementation(async (input) => {
      const report = await actual(input);
      // Inject at the shared process boundary after real containment, so the fixture
      // cannot leak its process while exercising an unconfirmed result.
      return { ...report, failed: [{ groupId: 'fixture-unconfirmed', diagnostic: 'unconfirmed' }] } as never;
    });
    cards.deleteSubtrees([child.id], () => true, 'analyst');
    expect(() => manager.getServerCatalog(MCP_OPERATOR_CALLER, 'peer')).toThrow('unavailable');
    await expect(manager.startServer(cardCaller(a.id), 'peer')).rejects.toThrow('unavailable');
    await expect(manager.unregisterServer(cardCaller(a.id), 'peer')).rejects.toThrow('containment');
    const status = manager.getServerStatus(cardCaller(a.id), 'peer')!;
    expect(status).toMatchObject({ status: 'error', ready: false, containment: 'failed', failureReason: 'containment_failed', definitionSource: null, policy: { controllerCardId: child.id } });
    expect(status.availableActions).toEqual(['mcp_server_control']);
    expect(manager.getStatus(cardCaller(b.id))).toEqual([]);
    await expect(manager.stopServer(cardCaller(a.id), 'peer')).rejects.toThrow('containment');
    expect(containment).toHaveBeenCalledTimes(1);
    expect(() => manager.registerServer(cardCaller(a.id), 'peer', connection)).toThrow('containment');
    managers.splice(managers.indexOf(manager), 1);
    containment.mockRestore();
    await expect(manager.cleanupForApplicationStop()).rejects.toThrow('containment');
  });

  it('reports stopping/nonready until shared ProcessRunner containment and settlement finish', async () => {
    const { manager, runner, a } = setup();
    manager.registerServer(cardCaller(a.id), 'peer', connection);
    await manager.startServer(cardCaller(a.id), 'peer');
    const actual = runner.closeAndTerminateDirectScope.bind(runner);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const containment = jest.spyOn(runner, 'closeAndTerminateDirectScope').mockImplementation(async (input) => {
      const result = await actual(input);
      entered();
      await gate;
      return result;
    });
    try {
      const stopping = manager.stopServer(cardCaller(a.id), 'peer');
      await waiting;
      expect(manager.getServerStatus(cardCaller(a.id), 'peer')).toMatchObject({
        status: 'stopping', ready: false, containment: 'pending', failureReason: null,
        containmentBoundary: 'local_process_group',
      });
      release();
      await stopping;
      expect(manager.getServerStatus(cardCaller(a.id), 'peer')).toMatchObject({
        status: 'stopped', ready: false, containment: 'contained', failureReason: null,
      });
    } finally { release(); containment.mockRestore(); }
  });
});
