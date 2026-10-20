import { describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { testConfigAuthority } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { createServer, closeServer, listen, readJsonRequest, waitFor } from '../helpers/production-composition-e2e.js';
import { BoundAgentToolSet, resolveRuntimeTool } from '../../src/tools/runtime-tool-catalog.js';
import { invokeToolForLlm } from '../../src/tools/invocation.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { testLlmToolInvocationContext, unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import type { McpToolInvocationPort } from '../../src/mcp/manager-api.js';
import Fastify from 'fastify';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { mcpOperatorApiContracts } from '../../src/contracts/operator-api-mcp.js';
import { buildMcpOperatorContractHandlers } from '../../src/server/routes/operator-mcp-handlers.js';
import { createMcpToolInvocationInstallation } from '../../src/mcp/tool-invocation-installation.js';
import { replaceFile } from '../../src/persistence/replace-file.js';

const A = [
  { name: 'common', inputSchema: { type: 'object', properties: { value: { type: 'string' }, hold: { type: 'boolean' } }, required: ['value'], additionalProperties: false } },
  { name: 'removed', inputSchema: { type: 'object' } },
];
const B = [
  { name: 'common', inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false, 'x-preserved': { flag: true } } },
  { name: 'added', inputSchema: { type: 'object', properties: { permitted: true, denied: false } } },
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-catalog-'));
  mkdirSync(join(root, '.saivage'));
  writeFileSync(join(root, '.saivage/saivage.yaml'), YAML.stringify({ ...structuredClone(TEST_SAIVAGE_CONFIG), mcpServers: {} }));
  const groups = new ManagedProcessGroupRegistry();
  const runner = new ProcessRunner(root, groups, testApplicationFatalPort);
  const events = { appendEventPrepared: jest.fn() };
  const manager = new McpManager({ configAuthority: testConfigAuthority(root), processRunner: runner, mcpProcessRootScope: groups.createContainerScope(groups.rootScope, 'mcp'), eventLogger: events as never });
  return { root, manager, events, async close() { await manager.cleanupForApplicationStop(); rmSync(root, { recursive: true }); } };
}

function stdioPeer(root: string, name: string) {
  const control = join(root, `${name}-control.json`);
  const wire = join(root, `${name}-wire.jsonl`);
  const script = join(root, `${name}.cjs`);
  const set = (mode: string, release = false) => replaceFile(control, Buffer.from(JSON.stringify({ mode, release })));
  set('A'); writeFileSync(wire, '');
  writeFileSync(script, `
const fs=require('node:fs'),rl=require('node:readline');
const A=${JSON.stringify(A)},B=${JSON.stringify(B)};
const control=()=>JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(wire)},line+'\\n');
 if(r.method==='initialize')return send(r.id,{});
 if(r.method==='notifications/initialized')return;
 if(r.method==='tools/call') {
  const done=()=>send(r.id,{content:[{type:'text',text:'known:'+r.params.arguments.value}]});
  if(!r.params.arguments.hold)return done();
  const timer=setInterval(()=>{if(control().release){clearInterval(timer);done();}},5);
   return;
 }
 const {mode}=control();
 if(mode==='close')return process.stdout.end();
 if(mode==='hold')return;
 if(mode==='A')return send(r.id,{tools:A});
 if(!r.params?.cursor)return send(r.id,{tools:[B[0]],nextCursor:'final'});
 if(mode==='reject')return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32001,message:'private remote message'}})+'\\n');
 if(mode==='malformed')return send(r.id,{tools:'not-an-array'});
 if(mode==='duplicate')return send(r.id,{tools:[B[0]]});
 return send(r.id,{tools:[B[1]]});
});`);
  return { set, calls: () => readFileSync(wire, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)), connection: { transport: 'stdio' as const, command: process.execPath, args: [script] } };
}

async function discover(manager: McpManager, name: string) {
  const surface = new BoundAgentToolSet([resolveRuntimeTool('card', 'mcp_tools')]).bind({ scope: 'card', agentName: 'executor', projectRoot: '/', mcpToolInvocation: manager } as never);
  const result = await invokeToolForLlm(surface, 'mcp_tools', { serverName: name }, testLlmToolInvocationContext({ toolName: 'mcp_tools' }));
  return settleToolActionOutcome(result.kind === 'executed' ? result.execution.providerOutcome : result.providerOutcome).providerResult;
}

describe('explicit catalog refresh through real local peers', () => {
  it('restarts a stdio owner with a distinct process, fences active/queued old calls and leaves the second server alone', async () => {
    const f = fixture(); const peer = stdioPeer(f.root, 'restart-one'); const other = stdioPeer(f.root, 'restart-other');
    try {
      for (const [name, p] of [['one', peer], ['other', other]] as const) { f.manager.registerServer(name, p.connection); await f.manager.startServer(name); }
      const a = f.manager.getServerCatalog('one')!; const untouched = f.manager.getServerCatalog('other')!;
      const oldProcess = f.manager.getServerStatus('one')!.processId;
      const known = await f.manager.invokeTool('one', a.bindingId, a.catalogId, 'common', { value: 'completed' });
      const active = f.manager.invokeTool('one', a.bindingId, a.catalogId, 'common', { value: 'held', hold: true }).catch(error => error);
      await waitFor(() => peer.calls().filter(r => r.method === 'tools/call').length === 2, 'active stdio call before restart');
      const queued = f.manager.invokeTool('one', a.bindingId, a.catalogId, 'common', { value: 'queued' }).catch(error => error);
      peer.set('B');
      await expect(f.manager.restartServer('one')).resolves.toMatchObject({ status: 'running', toolCount: 2 });
      expect(await active).toBeInstanceOf(Error); expect(await queued).toBeInstanceOf(Error);
      expect(peer.calls().filter(r => r.method === 'tools/call')).toHaveLength(2);
      const b = f.manager.getServerCatalog('one')!;
      expect(b.bindingId).not.toBe(a.bindingId); expect(b.catalogId).not.toBe(a.catalogId); expect(b.tools).toEqual(B);
      expect(oldProcess).not.toBeNull(); expect(f.manager.getServerStatus('one')!.processId).not.toBe(oldProcess);
      expect(peer.calls().filter(r => r.method === 'initialize')).toHaveLength(2);
      await expect(f.manager.invokeTool('one', a.bindingId, a.catalogId, 'common', { value: 'stale' })).rejects.toThrow('Stale MCP binding');
      await f.manager.invokeTool('one', b.bindingId, b.catalogId, 'common', { value: 5 });
      expect(known).toMatchObject({ content: [{ text: 'known:completed' }] });
      expect(f.manager.getServerCatalog('other')).toEqual(untouched);
      await f.manager.invokeTool('other', untouched.bindingId, untouched.catalogId, 'common', { value: 'unaffected' });
    } finally { await f.close(); }
  }, 20_000);

  it('routes authenticated socket restart through the installed manager to a fresh HTTP session, with readiness only after discovery', async () => {
    const f = fixture(); const operator = Fastify({ logger: false });
    let session = 0; let releaseList: (() => void) | undefined; let failure: unknown;
    const wire: Array<{ method: string; session: unknown }> = [];
    const peer = createServer(async (req, res) => {
      try {
        const body = await readJsonRequest(req);
        wire.push({ method: body.method, session: req.headers['mcp-session-id'] });
        if (body.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
        res.setHeader('content-type', 'application/json');
        const send = (result: unknown) => res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        if (body.method === 'initialize') { session++; res.setHeader('Mcp-Session-Id', `session-${session}`); send({}); }
        else if (body.method === 'tools/list' && session === 2) releaseList = () => send({ tools: B });
        else if (body.method === 'tools/list') send({ tools: A });
        else send({ content: [{ type: 'text', text: 'remote-still-alive' }] });
      } catch (error) { failure = error; res.statusCode = 500; res.end(); }
    });
    const other = stdioPeer(f.root, 'socket-unrelated');
    try {
      const port = await listen(peer);
      f.manager.registerServer('one', { transport: 'streamable-http', url: `http://127.0.0.1:${port}` });
      f.manager.registerServer('other', other.connection);
      await f.manager.startServer('one'); await f.manager.startServer('other');
      const a = f.manager.getServerCatalog('one')!; const untouched = f.manager.getServerCatalog('other')!;
      const installation = createMcpToolInvocationInstallation(); installation.installer.install(f.manager);
      new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'synthetic-token' }), eventLogger: { appendEventPrepared() {} } as never, fatalPort: testApplicationFatalPort }).mount(operator, mcpOperatorApiContracts, buildMcpOperatorContractHandlers({ mcpLifecycle: installation.port, mcpToolsProvider: f.manager }));
      const address = await operator.listen({ host: '127.0.0.1', port: 0 });
      const url = `${address}/api/mcp/servers/one/restart`;
      const post = (authenticated: boolean, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer synthetic-token' } : {}) }, body: JSON.stringify(body) });
      expect((await post(false, { forbidden: true })).status).toBe(401);
      expect((await post(true, { forbidden: true })).status).toBe(400);
      expect(session).toBe(1);
      let settled = false;
      const restart = post(true, {}).then(response => { settled = true; return response; });
      await waitFor(() => releaseList !== undefined, 'replacement HTTP discovery');
      expect(settled).toBe(false); expect(f.manager.getServerCatalog('one')).toBeUndefined();
      expect(f.manager.getServerStatus('one')).toMatchObject({ status: 'starting' });
      await expect(f.manager.invokeTool('one', a.bindingId, a.catalogId, 'common', { value: 'old' })).rejects.toThrow('not running');
      expect(f.manager.getServerCatalog('other')).toEqual(untouched);
      await f.manager.invokeTool('other', untouched.bindingId, untouched.catalogId, 'common', { value: 'during discovery' });
      releaseList!();
      const response = await restart; expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ serverName: 'one', status: 'running', toolCount: 2 });
      const b = f.manager.getServerCatalog('one')!;
      expect(b.bindingId).not.toBe(a.bindingId); expect(b.catalogId).not.toBe(a.catalogId); expect(b.tools).toEqual(B);
      await f.manager.invokeTool('one', b.bindingId, b.catalogId, 'common', { value: 7 });
      expect(wire.filter(r => r.method === 'initialize')).toHaveLength(2);
      expect(wire.at(-1)).toEqual({ method: 'tools/call', session: 'session-2' });
      // The synthetic remote service remains listening: restart owns only the local HTTP session.
      expect(peer.listening).toBe(true);
      expect(f.manager.getServerCatalog('other')).toEqual(untouched);
      if (failure) throw failure;
    } finally { releaseList?.(); await operator.close(); try { await f.close(); } finally { await closeServer(peer); } }
  }, 20_000);
  it('rejects missing, disabled, unready, stale and edited definitions without starting or reconciling services', async () => {
    const f = fixture(); const peer = stdioPeer(f.root, 'operator');
    const binding = '11111111-1111-4111-8111-111111111111';
    const config = { ...structuredClone(TEST_SAIVAGE_CONFIG), mcpServers: { operator: { ...structuredClone(peer.connection), autostart: false }, disabled: { ...structuredClone(peer.connection), disabled: true } } };
    writeFileSync(join(f.root, '.saivage/saivage.yaml'), YAML.stringify(config));
    try {
      expect(() => f.manager.refreshServerCatalog('missing', binding)).toThrow('Unknown configured');
      expect(() => f.manager.refreshServerCatalog('disabled', binding)).toThrow('disabled');
      expect(() => f.manager.refreshServerCatalog('operator', binding)).toThrow('not running');
      expect(peer.calls()).toEqual([]);
      await f.manager.startServer('operator');
      const catalog = f.manager.getServerCatalog('operator')!;
      await expect(f.manager.refreshServerCatalog('operator', binding)).rejects.toThrow('Stale MCP binding');
      config.mcpServers.operator.args = [...peer.connection.args, 'changed-definition'];
      writeFileSync(join(f.root, '.saivage/saivage.yaml'), YAML.stringify(config));
      expect(() => f.manager.refreshServerCatalog('operator', catalog.bindingId)).toThrow('does not reconcile configuration');
      expect(f.manager.getServerCatalog('operator')).toEqual(catalog);
      expect(peer.calls().filter(r => r.method === 'tools/list')).toHaveLength(1);
      expect(f.events.appendEventPrepared).not.toHaveBeenCalled();
    } finally { await f.close(); }
  }, 20_000);

  it('serializes a full stdio replacement between an active A call and stale queued calls without remote telemetry for local rejection', async () => {
    const f = fixture(); const peer = stdioPeer(f.root, 'one'); const other = stdioPeer(f.root, 'other');
    try {
      for (const [name, p] of [['one', peer], ['other', other]] as const) { f.manager.registerServer(name, p.connection); await f.manager.startServer(name); }
      const a = f.manager.getServerCatalog('one')!; const unrelated = f.manager.getServerCatalog('other')!;
      expect(f.manager.findToolCapability('one', 'common')).toMatchObject({ serverName: 'one', bindingId: a.bindingId, catalogId: a.catalogId, inputSchema: A[0]!.inputSchema });
      const active = f.manager.invokeTool('one', a.bindingId, a.catalogId, 'common', { value: 'A', hold: true });
      void active.catch(() => undefined);
      await waitFor(() => peer.calls().some(r => r.method === 'tools/call'), 'held stdio A call');
      const invalidQueued = f.manager.invokeTool('one', a.bindingId, a.catalogId, 'common', { value: 42 }).catch(error => error);
      peer.set('B');
      const refresh = f.manager.refreshServerCatalog('one', a.bindingId); void refresh.catch(() => undefined);
      const stale = f.manager.invokeTool('one', a.bindingId, a.catalogId, 'common', { value: 'A' }).catch(error => error);
      await expect(f.manager.refreshServerCatalog('one', a.bindingId)).rejects.toThrow('busy');
      expect(f.manager.getServerCatalog('one')).toEqual(a);
      peer.set('B', true);
      await expect(active).resolves.toMatchObject({ content: [{ text: 'known:A' }] });
      const result = await refresh;
      expect(await invalidQueued).toMatchObject({ code: 'INVALID_ARGUMENTS', data: { source: 'local_input_schema_validation' } });
      expect(result).toMatchObject({ serverName: 'one', bindingId: a.bindingId, toolCount: 2 });
      expect(result.catalogId).not.toBe(a.catalogId);
      expect((await stale).message).toContain('Stale MCP catalog');
      const b = f.manager.getServerCatalog('one')!;
      expect(b.tools).toEqual(B);
      expect(await discover(f.manager, 'one')).toEqual({ success: true, data: b });
      const before = peer.calls().filter(r => r.method === 'tools/call').length;
      for (const [name, args] of [['removed', {}], ['common', { value: 'wrong' }]] as const)
        await expect(f.manager.invokeTool('one', b.bindingId, b.catalogId, name, args)).rejects.toThrow();
      expect(peer.calls().filter(r => r.method === 'tools/call')).toHaveLength(before);
      expect(f.manager.getInvocationStats()['one:common']).toMatchObject({ total: 1, success: 1, error: 0 });
      expect(f.events.appendEventPrepared).toHaveBeenCalledTimes(1);
      await f.manager.invokeTool('one', b.bindingId, b.catalogId, 'common', { value: 2 });
      const same = await f.manager.refreshServerCatalog('one', b.bindingId);
      expect(same.catalogId).not.toBe(b.catalogId);
      expect(peer.calls().filter(r => r.method === 'initialize')).toHaveLength(1);
      expect(peer.calls().filter(r => r.method === 'notifications/initialized')).toHaveLength(1);
      expect(peer.calls().filter(r => r.method === 'tools/list').map(r => r.params?.cursor)).toEqual([undefined, undefined, 'final', undefined, 'final']);
      expect(f.manager.getServerCatalog('other')).toEqual(unrelated);
      await f.manager.invokeTool('other', unrelated.bindingId, unrelated.catalogId, 'common', { value: 'untouched' });
    } finally { await f.close(); }
  }, 20_000);

  it('preserves last-good catalogs on correlated final-page rejection/malformed data and contains only uncorrelated stdio closure', async () => {
    const f = fixture(); const peer = stdioPeer(f.root, 'one'); const other = stdioPeer(f.root, 'other');
    try {
      for (const [name, p] of [['one', peer], ['other', other]] as const) { f.manager.registerServer(name, p.connection); await f.manager.startServer(name); }
      const a = f.manager.getServerCatalog('one')!; const untouched = f.manager.getServerCatalog('other')!;
      for (const mode of ['reject', 'malformed', 'duplicate']) {
        peer.set(mode);
        const error = await f.manager.refreshServerCatalog('one', a.bindingId).catch(error => error);
        expect(error.message).toContain('last successful catalog unchanged');
        expect(error.message).not.toContain('private remote message');
        expect(f.manager.getServerCatalog('one')).toEqual(a);
      }
      expect(f.manager.getInvocationStats()).toEqual({}); expect(f.events.appendEventPrepared).not.toHaveBeenCalled();
      peer.set('close');
      await expect(f.manager.refreshServerCatalog('one', a.bindingId)).rejects.toThrow('connection closed');
      expect(f.manager.getServerCatalog('one')).toBeUndefined();
      peer.set('A');
      // A separately authored ordinary start works after refresh's owning stop join.
      await expect(f.manager.startServer('one')).resolves.toMatchObject({ status: 'running' });
      expect(f.manager.getServerCatalog('other')).toEqual(untouched);
      await f.manager.invokeTool('other', untouched.bindingId, untouched.catalogId, 'common', { value: 'still-live' });
    } finally { await f.close(); }
  }, 20_000);

  it('bounds queued refresh at admission without interrupting the active call or reopening busy admission before its queued no-op settles', async () => {
    const f = fixture(); const peer = stdioPeer(f.root, 'one');
    try {
      f.manager.registerServer('one', peer.connection); await f.manager.startServer('one');
      const a = f.manager.getServerCatalog('one')!;
      const active = f.manager.invokeTool('one', a.bindingId, a.catalogId, 'common', { value: 'held', hold: true }, { timeoutMs: 120_000 }); void active.catch(() => undefined);
      await waitFor(() => peer.calls().some(r => r.method === 'tools/call'), 'active before queue timeout');
      jest.useFakeTimers();
      const refresh = f.manager.refreshServerCatalog('one', a.bindingId).catch(error => error);
      jest.advanceTimersByTime(30_000);
      expect((await refresh).message).toContain('timed out');
      await expect(f.manager.refreshServerCatalog('one', a.bindingId)).rejects.toThrow('busy');
      expect(f.manager.getServerCatalog('one')).toEqual(a);
      expect(peer.calls().filter(r => r.method === 'tools/list')).toHaveLength(1);
      jest.useRealTimers(); peer.set('A', true);
      await expect(active).resolves.toMatchObject({ content: [{ text: 'known:held' }] });
      // Queue completion is ordered before this separately admitted invocation.
      await f.manager.invokeTool('one', a.bindingId, a.catalogId, 'common', { value: 'after' });
      await expect(f.manager.refreshServerCatalog('one', a.bindingId)).resolves.toMatchObject({ bindingId: a.bindingId });
      expect(peer.calls().filter(r => r.method === 'tools/call')).toHaveLength(2);
      expect(f.manager.getInvocationStats()['one:common']).toMatchObject({ total: 2, error: 0 });
    } finally { jest.useRealTimers(); await f.close(); }
  }, 20_000);

  it.each(['cancel', 'deadline', 'stop'] as const)('joins active stdio refresh %s containment without late publication and permits a separate start', async mode => {
    const f = fixture(); const peer = stdioPeer(f.root, 'one');
    try {
      f.manager.registerServer('one', peer.connection); await f.manager.startServer('one');
      const a = f.manager.getServerCatalog('one')!; peer.set('hold');
      const caller = new AbortController();
      const refresh = f.manager.refreshServerCatalog('one', a.bindingId, { signal: caller.signal }).catch(error => error);
      await waitFor(() => peer.calls().filter(r => r.method === 'tools/list').length === 2, 'active refresh list');
      if (mode === 'stop') await f.manager.stopServer('one');
      else if (mode === 'cancel') caller.abort(new Error('explicit refresh cancellation'));
      const error = await refresh;
      if (mode === 'deadline') expect(error.message).toContain('timed out');
      expect(f.manager.getServerCatalog('one')).toBeUndefined();
      expect(f.manager.getInvocationStats()).toEqual({}); expect(f.events.appendEventPrepared).not.toHaveBeenCalled();
      jest.useRealTimers(); peer.set('A');
      await expect(f.manager.startServer('one')).resolves.toMatchObject({ status: 'running' });
    } finally { jest.useRealTimers(); await f.close(); }
  }, 40_000);

  it('refreshes the same HTTP session while an A call is in flight, retains its response and keeps cancellation request-local', async () => {
    const f = fixture(); let mode = 'A'; let failure: unknown;
    const wire: Array<{ method: string; session: unknown; cursor?: string }> = [];
    let finishCall: (() => void) | undefined; let heldList = false;
    const peer = createServer(async (req, res) => {
      try {
        const body = await readJsonRequest(req);
        wire.push({ method: body.method, session: req.headers['mcp-session-id'], cursor: body.params?.cursor });
        if (body.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
        res.setHeader('content-type', 'application/json');
        const send = (result: unknown) => res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        if (body.method === 'initialize') { res.setHeader('Mcp-Session-Id', 'same-session'); send({}); }
        else if (body.method === 'tools/call' && body.params.arguments.value === 'held') finishCall = () => send({ content: [{ type: 'text', text: 'original-A-outcome' }] });
        else if (body.method === 'tools/call') send({ content: [] });
        else if (mode === 'hold') { heldList = true; res.flushHeaders(); }
        else if (mode === 'A') send({ tools: A });
        else send(body.params?.cursor ? { tools: [B[1]] } : { tools: [B[0]], nextCursor: 'final' });
      } catch (error) { failure = error; res.statusCode = 500; res.end(); }
    });
    try {
      const peerPort = await listen(peer);
      f.manager.registerServer('one', { transport: 'streamable-http', url: `http://127.0.0.1:${peerPort}` }); await f.manager.startServer('one');
      const a = f.manager.getServerCatalog('one')!;
      const active = f.manager.invokeTool('one', a.bindingId, a.catalogId, 'common', { value: 'held' }); void active.catch(() => undefined);
      await waitFor(() => finishCall !== undefined, 'held HTTP call'); mode = 'B';
      const b = await f.manager.refreshServerCatalog('one', a.bindingId);
      expect(b.catalogId).not.toBe(a.catalogId); expect(f.manager.getServerCatalog('one')!.tools).toEqual(B);
      finishCall!(); await expect(active).resolves.toMatchObject({ content: [{ text: 'original-A-outcome' }] });
      await expect(f.manager.invokeTool('one', a.bindingId, a.catalogId, 'common', { value: 'old' })).rejects.toThrow('Stale MCP catalog');
      expect(f.manager.getInvocationStats()['one:common']).toMatchObject({ total: 1, success: 1, error: 0 });
      mode = 'hold'; const caller = new AbortController(); const reason = new Error('cancel HTTP list');
      const refresh = f.manager.refreshServerCatalog('one', a.bindingId, { signal: caller.signal }).catch(error => error);
      await waitFor(() => heldList, 'held HTTP list body'); caller.abort(reason);
      expect(await refresh).toBe(reason);
      expect(f.manager.getServerCatalog('one')!.catalogId).toBe(b.catalogId);
      await f.manager.invokeTool('one', a.bindingId, b.catalogId, 'common', { value: 3 });
      expect(wire.filter(r => r.method === 'initialize')).toHaveLength(1);
      expect(wire.slice(1).every(r => r.session === 'same-session')).toBe(true);
      expect(wire.filter(r => r.method === 'tools/call')).toHaveLength(2);
      mode = 'B';
      const afterPublication = new AbortController();
      const invocationPort: McpToolInvocationPort = { ...unusedMcpToolInvocation, refreshServerCatalog: async (name, bindingId, options) => {
        const known = await f.manager.refreshServerCatalog(name, bindingId, options);
        afterPublication.abort(new Error('caller cancelled after known publication'));
        return known;
      } };
      const surface = new BoundAgentToolSet([resolveRuntimeTool('card', 'mcp_catalog_refresh')]).bind({ scope: 'card', agentName: 'executor', projectRoot: f.root, mcpToolInvocation: invocationPort } as never);
      const known = await invokeToolForLlm(surface, 'mcp_catalog_refresh', { serverName: 'one', bindingId: a.bindingId }, testLlmToolInvocationContext({ toolName: 'mcp_catalog_refresh' }), afterPublication.signal);
      expect(known).toMatchObject({ kind: 'executed', execution: { providerOutcome: { kind: 'succeeded', data: { catalogId: f.manager.getServerCatalog('one')!.catalogId, toolCount: 2 } } } });
      mode = 'hold'; heldList = false;
      const stoppingRefresh = f.manager.refreshServerCatalog('one', a.bindingId).catch(error => error);
      await waitFor(() => heldList, 'HTTP list before stop'); await f.manager.stopServer('one'); await stoppingRefresh;
      expect(f.manager.getServerCatalog('one')).toBeUndefined();
      if (failure) throw failure;
    } finally { try { await f.close(); } finally { await closeServer(peer); } }
  }, 20_000);
});
