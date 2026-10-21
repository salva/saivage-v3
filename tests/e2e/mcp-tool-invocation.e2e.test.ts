import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { pathToFileURL } from 'node:url';
import * as YAML from 'yaml';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import { readMcpServerDefinitions } from '../../src/mcp/server-definitions.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { testConfigAuthority } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

import type { App } from '../../src/boot/app.js';
import { EventQueryService } from '../../src/application/event-query-service.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import {
  appOrigin, closeServer, createServer, initializeProject, listen, offeredToolNames,
  postStartProject, productionTestConfig, readJsonRequest, sendFinalMessage,
  sendToolCall, startProductionApp, waitFor, writeProductionConfig,
  type ChatCompletionRequest,
} from '../helpers/production-composition-e2e.js';

const TOKEN = 'mcp-production-e2e-token';
const SERVER_NAME = 'marker-server';
const MARKER = 'mcp-production-composition-marker';
const roots: string[] = [];
const apps = new Set<App>();

afterEach(async () => {
  for (const app of [...apps]) await app.stop();
  apps.clear();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('MCP tool invocation production composition', () => {
  it('starts a HEAD-405 HTTP peer only through complete paginated protocol discovery', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-http-admission-'));
    roots.push(projectRoot);
    const calls: Array<{ method: string; operation?: string; session?: string; cursor?: string }> = [];
    let finishFinalPage: (() => void) | undefined;
    let fixtureFailure: unknown;
    const peer = createServer(async (req, res) => {
      try {
        if (req.method === 'HEAD') {
          calls.push({ method: 'HEAD' }); res.statusCode = 405; res.end(); return;
        }
        if (req.method !== 'POST') {
          calls.push({ method: req.method! }); throw new Error('Unexpected non-POST startup request');
        }
        const body = await readJsonRequest(req);
        calls.push({ method: req.method, operation: body.method, session: req.headers['mcp-session-id'] as string | undefined, cursor: body.params?.cursor });
        if (body.method === 'notifications/initialized') {
          res.statusCode = 202; res.end(); return;
        }
        res.setHeader('content-type', 'application/json');
        if (body.method === 'initialize') {
          res.setHeader('Mcp-Session-Id', 'loopback-session');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'offline-peer', version: '1' } } }));
        } else if (body.method === 'tools/list' && !body.params?.cursor) {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'page-two' } }));
        } else if (body.method === 'tools/list' && body.params?.cursor === 'page-two') {
          // Headers alone must not publish either readiness or a partial catalog.
          res.flushHeaders();
          finishFinalPage = () => res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'second', inputSchema: { type: 'object' } }] } }));
        } else throw new Error('Unexpected MCP startup operation');
      } catch (error) { fixtureFailure = error; res.statusCode = 500; res.end(); }
    });
    let manager: McpManager | undefined;
    try {
      const port = await listen(peer);
      mkdirSync(join(projectRoot, '.saivage'));
      writeFileSync(join(projectRoot, '.saivage/saivage.yaml'), YAML.stringify({ ...structuredClone(TEST_SAIVAGE_CONFIG), mcpServers: { offline: { transport: 'streamable-http', url: `http://127.0.0.1:${port}`, autostart: false } } }));
      const registry = new ManagedProcessGroupRegistry();
      const runner = new ProcessRunner(projectRoot, registry, testApplicationFatalPort);
      manager = new McpManager({ configAuthority: testConfigAuthority(projectRoot), processRunner: runner, mcpProcessRootScope: registry.createContainerScope(registry.rootScope, 'mcp'), eventLogger: { appendEventPrepared() {} } as never });
      let settled = false;
      const start = manager.startServer('offline', { signal: AbortSignal.timeout(5_000) }).then(result => { settled = true; return result; }, error => { settled = true; throw error; });
      // Attach a rejection observer while the bounded final-page wait is pending.
      void start.catch(() => undefined);
      await waitFor(() => finishFinalPage !== undefined || settled, 'final HTTP discovery page');
      if (fixtureFailure) throw fixtureFailure;
      expect(finishFinalPage).toBeDefined(); expect(settled).toBe(false);
      expect(manager.getServerStatus('offline')).toMatchObject({ status: 'starting', processId: null, startedAt: expect.any(String) });
      expect(manager.getServerCatalog('offline')?.tools).toBeUndefined();
      expect(calls.map(call => [call.method, call.operation])).toEqual([['POST', 'initialize'], ['POST', 'notifications/initialized'], ['POST', 'tools/list'], ['POST', 'tools/list']]);
      expect(calls[0]!.session).toBeUndefined();
      expect(calls.slice(1).map(call => call.session)).toEqual(['loopback-session', 'loopback-session', 'loopback-session']);
      expect(calls.map(call => call.cursor)).toEqual([undefined, undefined, undefined, 'page-two']);
      finishFinalPage!();
      await expect(start).resolves.toMatchObject({ status: 'running', toolCount: 2 });
      expect(manager.getServerCatalog('offline')!.tools.map(tool => tool.name)).toEqual(['first', 'second']);
      expect(manager.getServerStatus('offline')).toMatchObject({ status: 'running', processId: null });
      expect(calls).toHaveLength(4);
    } finally {
      try { await manager?.cleanupForApplicationStop(); }
      finally { await closeServer(peer); }
    }
  }, 20_000);
  it.each(['stdio', 'streamable-http'] as const)(
    'selected agent dynamically registers, discovers, calls and removes %s without changing its frozen gateway or another owner',
    async (transport) => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-dynamic-composition-'));
      roots.push(projectRoot);
      const callsPath = join(projectRoot, 'calls.jsonl');
      writeFileSync(callsPath, '');
      const script = join(projectRoot, 'peer.cjs');
      writeFileSync(
        script,
        `
const fs=require('node:fs'); const readline=require('node:readline');
const responseLabel=process.argv[2]||'pong';
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='initialize')send(r.id,{protocolVersion:'2025-06-18'});
 if(r.method==='tools/list')send(r.id,{tools:[{name:'ping',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}]});
 if(r.method==='tools/call') { fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({value:r.params.arguments.value,at:Date.now()})+'\\n');
  setTimeout(()=>{send(r.id,{content:[{type:'text',text:responseLabel+':'+r.params.arguments.value}]});if(r.params.arguments.value==='exit')setTimeout(()=>process.exit(0),30);},120); }
});`,
      );
      const wireCalls: unknown[] = [];
      let enterHeld!: () => void;
      let releaseHeld!: () => void;
      const heldEntered = new Promise<void>(resolve => { enterHeld = resolve; });
      const heldRelease = new Promise<void>(resolve => { releaseHeld = resolve; });
      const peer = createServer(async (req, res) => {
        const body = await readJsonRequest(req);
        if (body.method === 'notifications/initialized') {
          res.statusCode = 202;
          res.end();
          return;
        }
        if (body.method === 'tools/call') wireCalls.push(body.params);
        if (body.method === 'tools/call' && body.params.arguments.value === 'held-replacement') {
          enterHeld();
          await heldRelease;
        }
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result:
              body.method === 'tools/list'
                ? {
                    tools: [
                      {
                        name: 'ping',
                        inputSchema: {
                          type: 'object',
                          properties: { value: { type: 'string' } },
                          required: ['value'],
                          additionalProperties: false,
                        },
                      },
                    ],
                  }
                : body.method === 'tools/call'
                  ? { content: [{ type: 'text', text: `pong:${body.params.arguments.value}` }] }
                  : { protocolVersion: '2025-06-18' },
          }),
        );
      });
      const peerPort = await listen(peer);
      const httpConnection = {
        transport: 'streamable-http' as const,
        url: `http://127.0.0.1:${peerPort}`,
      };
      const connection =
        transport === 'stdio'
          ? {
              transport,
              command: process.execPath,
              args: [script],
              env: { CUSTOM: 'synthetic-private-env' },
            }
          : httpConnection;
      let app: App | null = null;
      let fixtureFailure: unknown;
      let step = 0;
      let binding = '';
      let catalogId = '';
      let processId: string | null = null;
      let gateway: unknown;
      const seen: string[] = [];
      let processWait: ReturnType<typeof jest.spyOn>;
      let processKill: ReturnType<typeof jest.spyOn>;
      let waitsBeforeDenial = 0;
      const provider = createServer(async (req, res) => {
        try {
          const body = (await readJsonRequest(req)) as ChatCompletionRequest;
          if (gateway === undefined) {
            gateway = body.tools;
            expect(body.tools?.find(tool => tool.function.name === 'mcp_server_replace')).toMatchObject({ function: { parameters: { required: ['serverName', 'connection'], additionalProperties: false } } });
          }
          else expect(body.tools).toEqual(gateway);
          const last = body.messages.at(-1);
          const settled = last?.role === 'tool' ? JSON.parse(last.content) : null;
          if (last?.role === 'tool') seen.push(last.tool_call_id!);
          const emit = (name: string, args: object) =>
            sendToolCall(res, name + '-' + step, name, args);
          step++;
          switch (step) {
            case 1:
              expect(app!.server.mcpManager.getServerStatus('dynamic')).toBeUndefined();
              emit('mcp_server_register', { serverName: 'dynamic', connection });
              break;
            case 2:
              expect(settled).toMatchObject({ success: true, data: { registered: true } });
              expect(app!.server.mcpManager.getServerStatus('dynamic')).toMatchObject({
                status: 'stopped',
                processId: null,
              });
              emit('mcp_server_control', { serverName: 'dynamic', action: 'start' });
              break;
            case 3:
              expect(settled).toMatchObject({ success: true, data: { status: 'running' } });
              emit('mcp_servers', { serverName: 'dynamic' });
              break;
            case 4: {
              expect(settled).toMatchObject({
                success: true,
                data: {
                  servers: [{ name: 'dynamic', definitionSource: 'agent', status: 'running' }],
                },
              });
              processId = settled.data.servers[0].processId;
              const runner = app!.server.runtimeApplication.processRunner;
              if (transport === 'stdio')
                expect(runner.get(processId!)).toMatchObject({
                  owner_id: 'mcp:dynamic',
                  owner_kind: 'runtime',
                  card_id: null,
                  evidence: { stdout: 'not_captured', stderr: 'not_captured' },
                });
              else expect(processId).toBeNull();
              emit('list_processes_tool', {});
              break;
            }
            case 5: {
              expect(settled.success).toBe(true);
              if (transport === 'stdio') {
                expect(JSON.stringify(settled)).toContain(processId!);
                expect(JSON.stringify(settled)).toContain('mcp:dynamic');
                expect(JSON.stringify(settled)).toContain('not_captured');
              }
              waitsBeforeDenial = processWait.mock.calls.length;
              emit('wait_process', { process_id: processId ?? 'proc-000000000000', timeout_ms: 0 });
              break;
            }
            case 6:
              expect(settled).toMatchObject({
                success: false,
                error: expect.stringContaining(
                  transport === 'stdio' ? 'not owned' : 'Unknown process',
                ),
              });
              expect(settled).not.toHaveProperty('data.stdout');
              emit('kill_process', { process_id: processId ?? 'proc-000000000000' });
              break;
            case 7:
              expect(settled).toMatchObject({
                success: false,
                error: expect.stringContaining(
                  transport === 'stdio' ? 'not owned' : 'Unknown process',
                ),
              });
              expect(processWait.mock.calls).toHaveLength(waitsBeforeDenial);
              expect(processKill).not.toHaveBeenCalled();
              if (processId)
                expect(app!.server.runtimeApplication.processRunner.get(processId)?.status).toBe(
                  'running',
                );
              emit('run_command', {
                command: 'printf independent-command',
                wait: true,
                timeout_ms: 2000,
              });
              break;
            case 8:
              expect(settled.success).toBe(true);
              expect(JSON.stringify(settled)).toContain('independent-command');
              emit('mcp_tools', { serverName: 'dynamic' });
              break;
            case 9:
              expect(settled.success).toBe(true);
              binding = settled.data.bindingId;
              catalogId = settled.data.catalogId;
              expect(binding).toEqual(expect.any(String));
              emit('mcp_tool_call', {
                serverName: 'dynamic',
                bindingId: binding,
                catalogId,
                toolName: 'ping',
                args: { value: 'selected-agent' },
              });
              break;
            case 10:
              expect(JSON.stringify(settled)).toContain('pong:selected-agent');
              emit('mcp_server_replace', { serverName: 'dynamic', connection: httpConnection });
              break;
            case 11:
              expect(settled).toMatchObject({ success: false, error: expect.stringContaining('containment') });
              expect(app!.server.mcpManager.getServerStatus('dynamic')!.bindingId).toBe(binding);
              emit('mcp_server_control', { serverName: 'dynamic', action: 'stop' });
              break;
            case 12:
              expect(settled.success).toBe(true);
              if (processId)
                expect(app!.server.runtimeApplication.processRunner.get(processId)).toBeNull();
              emit('mcp_server_replace', { serverName: 'dynamic', connection: httpConnection });
              break;
            case 13:
              expect(settled).toEqual({ success: true, data: { serverName: 'dynamic', replaced: true, status: 'stopped' } });
              expect(readMcpServerDefinitions(projectRoot)).toEqual({ dynamic: httpConnection });
              expect(app!.server.mcpManager.getServerStatus('dynamic')).toMatchObject({ status: 'stopped', transport: 'streamable-http', bindingId: null, processId: null, tools_count: 0 });
              emit('mcp_server_control', { serverName: 'dynamic', action: 'start' });
              break;
            case 14:
              expect(settled).toMatchObject({ success: true, data: { status: 'running' } });
              emit('mcp_tools', { serverName: 'dynamic' });
              break;
            case 15:
              expect(settled.success).toBe(true);
              expect(settled.data.bindingId).not.toBe(binding);
              emit('mcp_tool_call', { serverName: 'dynamic', bindingId: binding, catalogId, toolName: 'ping', args: { value: 'stale-no-dispatch' } });
              break;
            case 16:
              expect(settled).toMatchObject({ success: false, error: expect.stringContaining('Stale MCP binding') });
              expect(JSON.stringify(wireCalls)).not.toContain('stale-no-dispatch');
              emit('mcp_tool_call', { serverName: 'dynamic', bindingId: app!.server.mcpManager.getServerStatus('dynamic')!.bindingId!, catalogId: app!.server.mcpManager.getServerCatalog('dynamic')!.catalogId, toolName: 'ping', args: { value: 'replacement-B' } });
              break;
            case 17:
              expect(JSON.stringify(settled)).toContain('pong:replacement-B');
              {
                const manager = app!.server.mcpManager;
                const before = manager.getServerStatus('dynamic');
                const call = manager.invokeTool('dynamic', before!.bindingId!, manager.getServerCatalog('dynamic')!.catalogId, 'ping', { value: 'held-replacement' });
                await heldEntered;
                expect(() => manager.replaceServer('dynamic', connection)).toThrow('containment');
                expect(manager.getServerStatus('dynamic')!.bindingId).toBe(before!.bindingId);
                releaseHeld();
                await expect(call).resolves.toMatchObject({ content: [{ text: 'pong:held-replacement' }] });
              }
              emit('mcp_server_control', { serverName: 'dynamic', action: 'stop' });
              break;
            case 18:
              expect(settled.success).toBe(true);
              emit('mcp_server_unregister', { serverName: 'dynamic' });
              break;
            case 19:
              expect(settled).toMatchObject({ success: true, data: { unregistered: true } });
              sendFinalMessage(res, 'Dynamic connection removed.');
              break;
            default:
              throw new Error('unexpected scripted provider step');
          }
        } catch (error) {
          fixtureFailure = error;
          res.statusCode = 500;
          res.end();
        }
      });
      try {
        const providerPort = await listen(provider);
        writeProductionConfig(
          projectRoot,
          productionTestConfig(providerPort, (config) => {
            config.agents.analyst!.tools.push(
              'mcp_server_register',
              'mcp_server_replace',
              'mcp_server_unregister',
              'mcp_servers',
            );
            config.mcpServers = {
              independent: { ...httpConnection, autostart: true, disabled: false },
            };
          }),
        );
        initializeProject(projectRoot);
        app = await startProductionApp(projectRoot, TOKEN);
        apps.add(app);
        // Observation-only spies retain the real shared runner and owner mechanics.
        processWait = jest.spyOn(app.server.runtimeApplication.processRunner, 'waitForSettlement');
        processKill = jest.spyOn(app.server.runtimeApplication.processRunner, 'kill');
        const independentBefore = app.server.mcpManager.getServerCatalog('independent')!;
        const response = await fetch(`${appOrigin(app)}/api/chat`, {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'Exercise the selected dynamic connection tools.' }),
        });
        const reply = await response.json();
        if (fixtureFailure) throw fixtureFailure;
        expect(response.status).toBe(200);
        expect(step).toBe(19);
        expect(seen).toHaveLength(18);
        expect(JSON.stringify(reply)).not.toContain('synthetic-private-env');
        const manager = app.server.mcpManager;
        expect(manager.getServerCatalog('independent')).toEqual(independentBefore);
        const runner = app.server.runtimeApplication.processRunner;
        await expect(
          manager.invokeTool(
            'independent',
            manager.getServerStatus('independent')!.bindingId!,
            manager.getServerCatalog('independent')!.catalogId,
            'ping',
            { value: 'independent' },
          ),
        ).resolves.toMatchObject({ content: [{ text: 'pong:independent' }] });
        expect(peer.listening).toBe(true);
        expect(manager.getServerStatus('dynamic')).toMatchObject({
          definitionSource: null,
          status: 'stopped',
          processId: null,
        });
        const rows = readConversation(projectRoot, 'agent:analyst:global').physicalRows;
        expect(rows.filter((r) => r.kind === 'tool_call').map((r) => r.tool_call_id)).toEqual(seen);
        expect(rows.filter((r) => r.kind === 'tool_result').map((r) => r.tool_call_id)).toEqual(
          seen,
        );
        const wireCount = () =>
          transport === 'stdio'
            ? readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).length
            : wireCalls.length;
        manager.registerServer('dynamic', connection);
        await manager.startServer('dynamic');
        const replacementBinding = manager.getServerStatus('dynamic')!.bindingId!;
        expect(replacementBinding).not.toBe(binding);
        const beforeStale = wireCount();
        await expect(
          manager.invokeTool('dynamic', binding, catalogId, 'ping', { value: 'never-dispatched' }),
        ).rejects.toThrow('Stale MCP binding');
        expect(wireCount()).toBe(beforeStale);
        await manager.invokeTool('dynamic', replacementBinding, manager.getServerCatalog('dynamic')!.catalogId, 'ping', { value: 'bound-B' });
        expect(wireCount()).toBe(beforeStale + 1);
        if (transport === 'stdio') {
          const oldCatalog = manager.getServerCatalog('dynamic')!.catalogId;
          const oldProcess = manager.getServerStatus('dynamic')!.processId!;
          await manager.stopServer('dynamic');
          expect(runner.get(oldProcess)).toBeNull();
          const stdioB = { transport: 'stdio' as const, command: process.execPath, args: [script, 'stdio-B'] };
          expect(manager.replaceServer('dynamic', stdioB)).toEqual({ serverName: 'dynamic', replaced: true, status: 'stopped' });
          expect(readMcpServerDefinitions(projectRoot)).toEqual({ dynamic: stdioB });
          expect(manager.getServerStatus('dynamic')).toMatchObject({ status: 'stopped', transport: 'stdio', bindingId: null, processId: null, tools_count: 0 });
          const beforeStdioB = wireCount();
          await manager.startServer('dynamic');
          const fresh = manager.getServerCatalog('dynamic')!;
          expect(fresh.bindingId).not.toBe(replacementBinding);
          expect(fresh.catalogId).not.toBe(oldCatalog);
          await expect(manager.invokeTool('dynamic', replacementBinding, oldCatalog, 'ping', { value: 'stale-stdio-A' })).rejects.toThrow('Stale MCP binding');
          await expect(manager.invokeTool('dynamic', fresh.bindingId, oldCatalog, 'ping', { value: 'stale-stdio-catalog' })).rejects.toThrow('Stale MCP catalog');
          expect(wireCount()).toBe(beforeStdioB);
          await expect(manager.invokeTool('dynamic', fresh.bindingId, fresh.catalogId, 'ping', { value: 'stdio-replacement' })).resolves.toMatchObject({ content: [{ text: 'stdio-B:stdio-replacement' }] });
          expect(wireCount()).toBe(beforeStdioB + 1);
        }
        await manager.unregisterServer('dynamic');
        if (transport === 'stdio') {
          manager.registerServer('serial', connection);
          await manager.startServer('serial');
          const serialBinding = manager.getServerStatus('serial')!.bindingId!;
          const before = Date.now();
          const queuedCalls = Promise.all([
            manager.invokeTool('serial', serialBinding, manager.getServerCatalog('serial')!.catalogId, 'ping', { value: 'first' }),
            manager.invokeTool('serial', serialBinding, manager.getServerCatalog('serial')!.catalogId, 'ping', { value: 'second' }),
          ]);
          expect(() => manager.replaceServer('serial', httpConnection)).toThrow('containment');
          await queuedCalls;
          const calls = readFileSync(callsPath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          expect(calls.map((c) => c.value)).toEqual([
            'selected-agent',
            'bound-B',
            'stdio-replacement',
            'first',
            'second',
          ]);
          expect(calls[4].at - calls[3].at).toBeGreaterThanOrEqual(100);
          expect(Date.now() - before).toBeGreaterThanOrEqual(220);
          const serialProcess = manager.getServerStatus('serial')!.processId!;
          await manager.unregisterServer('serial');
          expect(runner.get(serialProcess)).toBeNull();
          manager.registerServer('natural', connection);
          await manager.startServer('natural');
          const naturalProcess = manager.getServerStatus('natural')!.processId!;
          await manager.invokeTool(
            'natural',
            manager.getServerStatus('natural')!.bindingId!,
            manager.getServerCatalog('natural')!.catalogId,
            'ping',
            { value: 'exit' },
          );
          await waitFor(() => runner.get(naturalProcess) === null, 'MCP natural exit retirement');
          // EOF containment can win the OS-exit race; never infer exit zero from EOF.
          expect(['stopped', 'error']).toContain(manager.getServerStatus('natural')!.status);
          expect(manager.getServerStatus('natural')).toMatchObject({ processId: null });
          await manager.unregisterServer('natural');
        } else expect(wireCalls).toHaveLength(5);
      } finally {
        releaseHeld();
        if (app) {
          apps.delete(app);
          await app.stop();
        }
        await closeServer(provider);
        await closeServer(peer);
      }
    },
    60_000,
  );
  it('serves lifetime workspace roots through a real synthetic stdio child and manager without replay', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mcp-lifetime-á space-'));
    roots.push(projectRoot);
    const script = join(projectRoot, 'peer.cjs');
    writeFileSync(
      script,
      `
const readline = require('node:readline');
const seen = []; const expected = []; let mutations = 0; let calls = 0; let pending; let idleAnnounced = false;
const send = m => JSON.stringify(m) + '\\n';
const roots = id => { expected.push(id); return { jsonrpc: '2.0', id, method: 'roots/list' }; };
function finish() {
  if (!pending || !idleAnnounced || !expected.every(id => seen.includes(id))) return;
  const request = pending; pending = undefined;
  if (request.params.name === 'report') {
    process.stdout.write(send({ jsonrpc: '2.0', id: request.id, result: { content: [], structuredContent: { mutations, calls, seen, cwd: process.cwd() } } })); return;
  }
  mutations++;
  process.stdout.write(send(roots('before-' + mutations)) + send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'mutation:' + mutations }] } }) + send(roots('after-' + mutations)));
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.result && request.result.roots) {
    if (request.result.roots[0].uri !== ${JSON.stringify(pathToFileURL(projectRoot).href)}) process.exit(9);
    seen.push(request.id); finish(); return;
  }
  if (request.method === 'initialize') {
    if (!request.params.capabilities.roots || request.params.capabilities.roots.listChanged !== false) process.exit(8);
    process.stdout.write(send({ jsonrpc: '2.0', id: request.id, result: {} }) + send(roots(request.id)));
  } else if (request.method === 'tools/list') {
    const result = request.params ? { tools: [{ name: 'report', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'mutate', inputSchema: { type: 'object' } }], nextCursor: 'two' };
    process.stdout.write(send({ jsonrpc: '2.0', id: request.id, result }) + send(roots('page-' + request.id)));
    if (request.params) setImmediate(() => { idleAnnounced = true; process.stdout.write(send(roots('idle'))); finish(); });
  } else if (request.method === 'tools/call') { calls++; pending = request; finish(); }
});
`,
    );
    mkdirSync(join(projectRoot, '.saivage'));
    writeFileSync(
      join(projectRoot, '.saivage', 'saivage.yaml'),
      YAML.stringify({
        ...structuredClone(TEST_SAIVAGE_CONFIG),
        mcpServers: {
          local: {
            transport: 'stdio',
            command: process.execPath,
            args: [script],
            autostart: false,
          },
        },
      }),
    );
    const registry = new ManagedProcessGroupRegistry();
    const mcpScope = registry.createContainerScope(registry.rootScope, 'mcp');
    const runner = new ProcessRunner(projectRoot, registry, testApplicationFatalPort);
    const manager = new McpManager({
      configAuthority: testConfigAuthority(projectRoot),
      processRunner: runner,
      mcpProcessRootScope: mcpScope,
      eventLogger: { appendEventPrepared() {} } as never,
    });
    try {
      await expect(manager.startServer('local')).resolves.toMatchObject({
        status: 'running',
        toolCount: 2,
      });
      for (let n = 1; n <= 2; n++)
        await expect(
          manager.invokeTool('local',
            manager.getServerStatus('local')!.bindingId!, manager.getServerCatalog('local')!.catalogId, 'mutate', {}, { timeoutMs: 5000 }),
        ).resolves.toMatchObject({ content: [{ type: 'text', text: `mutation:${n}` }] });
      await expect(
        manager.invokeTool('local',
          manager.getServerStatus('local')!.bindingId!, manager.getServerCatalog('local')!.catalogId, 'report', {}, { timeoutMs: 5000 }),
      ).resolves.toMatchObject({
        structuredContent: {
          mutations: 2,
          calls: 3,
          cwd: projectRoot,
          seen: [1, 'page-2', 'page-3', 'idle', 'before-1', 'after-1', 'before-2', 'after-2'],
        },
      });
      await manager.stopServer('local');
      expect(runner.list()).toEqual([]);
    } finally {
      await manager.cleanupForApplicationStop();
      expect(runner.list()).toEqual([]);
    }
  }, 20_000);
  it('records rejected discovery and continues with a distinct explicitly requested corrective Analyst start', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-mcp-discovery-e2e-')); roots.push(projectRoot);
    const failedId = 'discovery-rejected-unique'; const correctedId = 'discovery-corrected-unique';
    const methods: string[] = [];
    let corrected = false; let providerCalls = 0; let fixtureFailure: unknown;
    const mcp = createServer(async (request, response) => {
      try {
        const body = await readJsonRequest(request); methods.push(body.method);
        response.setHeader('content-type', 'application/json');
        if (body.method === 'initialize') response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...(corrected ? { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } } : { error: { code: -32006, message: 'secret external discovery detail' } }) }));
        else if (body.method === 'notifications/initialized') { response.statusCode = 202; response.end(); }
        else if (body.method === 'tools/list') response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }));
        else throw new Error('Unexpected MCP request');
      } catch (error) { fixtureFailure = error; response.statusCode = 500; response.end(); }
    });
    const provider = createServer(async (request, response) => {
      try {
        const body = await readJsonRequest(request) as ChatCompletionRequest;
        expect(offeredToolNames(body)).toContain('mcp_server_control');
        const last = body.messages.at(-1);
        providerCalls++;
        if (providerCalls === 1) {
          expect(methods).toEqual([]);
          sendToolCall(response, failedId, 'mcp_server_control', { serverName: SERVER_NAME, action: 'start' });
        } else if (providerCalls === 2) {
          expect(last).toMatchObject({ role: 'tool', tool_call_id: failedId });
          expect(JSON.parse(last!.content)).toMatchObject({ success: false, error: expect.stringContaining('initialize rejected (code -32006)') });
          expect(last!.content).not.toContain('secret external discovery detail');
          expect(methods).toEqual(['initialize']);
          corrected = true;
          sendToolCall(response, correctedId, 'mcp_server_control', { serverName: SERVER_NAME, action: 'start' });
        } else if (providerCalls === 3) {
          expect(last).toMatchObject({ role: 'tool', tool_call_id: correctedId });
          expect(JSON.parse(last!.content)).toMatchObject({ success: true, data: { serverName: SERVER_NAME, status: 'running', toolCount: 0 } });
          sendFinalMessage(response, 'Corrective new start completed.');
        } else throw new Error('Unexpected provider continuation');
      } catch (error) { fixtureFailure = error; response.statusCode = 500; response.end(); }
    });
    let app: App | null = null;
    try {
      const mcpPort = await listen(mcp); const providerPort = await listen(provider);
      writeProductionConfig(projectRoot, productionTestConfig(providerPort, config => {
        config.mcpServers = { [SERVER_NAME]: { transport: 'streamable-http', url: `http://127.0.0.1:${mcpPort}`, autostart: false, disabled: false } };
      }));
      initializeProject(projectRoot);
      app = await startProductionApp(projectRoot, TOKEN); apps.add(app);
      expect(methods).toEqual([]);
      const response = await fetch(`${appOrigin(app)}/api/chat`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Start the configured MCP server; if discovery is rejected, correct it and request a new start.' }) });
      const body = await response.json();
      if (fixtureFailure) throw fixtureFailure;
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ toolInvocations: [expect.objectContaining({ result: expect.objectContaining({ success: false }) }), expect.objectContaining({ result: expect.objectContaining({ success: true }) })] });
      expect(providerCalls).toBe(3);
      expect(methods).toEqual(['initialize', 'initialize', 'notifications/initialized', 'tools/list']);
      const rows = readConversation(projectRoot, 'agent:analyst:global').physicalRows;
      const lifecycleRows = rows.filter(row => row.tool === 'mcp_server_control');
      expect(lifecycleRows.map(row => [row.kind, row.tool_call_id])).toEqual([['tool_call', failedId], ['tool_result', failedId], ['tool_call', correctedId], ['tool_result', correctedId]]);
      for (const [id, success] of [[failedId, false], [correctedId, true]] as const) {
        const result = lifecycleRows.find(row => row.kind === 'tool_result' && row.tool_call_id === id)!;
        expect(result).toMatchObject({ context_policy: { kind: 'tool_result', settlement_origin: 'executed', evidence: { kind: 'none' } } });
        expect(JSON.parse(result.content).success).toBe(success);
      }
      expect(rows.filter(row => row.kind === 'tool_call').map(row => row.tool_call_id)).toEqual([failedId, correctedId]);
      expect(rows.filter(row => row.kind === 'tool_result').map(row => row.tool_call_id)).toEqual([failedId, correctedId]);
      expect(app.server.mcpManager.getServerCatalog(SERVER_NAME)?.tools).toEqual([]);
    } finally {
      if (app) { apps.delete(app); await app.stop(); }
      await closeServer(provider); await closeServer(mcp);
    }
  }, 60_000);
  it.each([true, false, undefined])('records native isError=%p through HTTP, settlement, status and durable operator Errors', async (isError) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-mcp-production-e2e-'));
    roots.push(projectRoot);
    const mcpMethods: string[] = [];
    const toolCalls: unknown[] = [];
    let fixtureFailure: Error | null = null;
    const mcp = createServer(async (request, response) => {
      try {
        if (request.method !== 'POST') throw new Error(`Unexpected MCP method '${request.method}'.`);
        const body = await readJsonRequest(request);
        mcpMethods.push(body.method);
        if (body.method === 'initialize') {
          response.setHeader('content-type', 'application/json');
          response.setHeader('Mcp-Session-Id', 'production-e2e-session');
          response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }));
        } else if (body.method === 'notifications/initialized') {
          response.statusCode = 202; response.end();
        } else if (body.method === 'tools/list') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'echo_marker', description: 'Echo one marker.', inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] } }] } }));
        } else if (body.method === 'tools/call') {
          toolCalls.push(body.params);
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
            content: [{ type: 'text', text: `echo:${body.params.arguments.marker}` }, ...(isError === true ? [{ type: 'image', mimeType: 'image/png', data: 'not selected' }] : [])],
            ...(isError === undefined ? {} : { isError }),
            _meta: { producer: 'synthetic-peer' },
          } }));
        } else throw new Error(`Unexpected MCP operation '${body.method}'.`);
      } catch (error) {
        fixtureFailure = error as Error;
        response.statusCode = 500; response.end();
      }
    });
    const mcpPort = await listen(mcp);

    let analystCalls = 0;
    let rootCalls = 0;
    let markerResultSeenByProvider: unknown = null;
    const provider = createServer(async (request, response) => {
      try {
        if (request.url !== '/v1/chat/completions') throw new Error(`Unexpected provider URL '${request.url}'.`);
        const body = await readJsonRequest(request) as ChatCompletionRequest;
        const tools = offeredToolNames(body);
        const last = body.messages.at(-1);
        if (tools.includes('start_project')) {
          analystCalls += 1;
          if (analystCalls === 1) sendToolCall(response, 'analyst-start', 'start_project', {});
          else if (analystCalls === 2) {
            const settled = JSON.parse(last?.content ?? 'null');
            if (last?.role !== 'tool' || settled.success !== true) throw new Error('Analyst continuation did not receive the successful start_project settlement.');
            sendFinalMessage(response, 'Project started.');
          } else throw new Error(`Unexpected Analyst request ${analystCalls}.`);
          return;
        }
        if (!tools.includes('mcp_tool_call') || !tools.includes('emit_result')) throw new Error(`Unexpected card-agent tool set: ${tools.join(',')}.`);
        rootCalls += 1;
        if (rootCalls === 1) {
          sendToolCall(response, 'mcp-call', 'mcp_tool_call', { serverName: SERVER_NAME,
              bindingId: app!.server.mcpManager.getServerStatus(SERVER_NAME)!.bindingId!, catalogId: app!.server.mcpManager.getServerCatalog(SERVER_NAME)!.catalogId, toolName: 'echo_marker', args: { marker: MARKER } });
        } else if (rootCalls === 2) {
          markerResultSeenByProvider = JSON.parse(last?.content ?? 'null');
          if (last?.role !== 'tool' || JSON.stringify(markerResultSeenByProvider).includes(MARKER) === false) throw new Error('Root continuation did not receive the marker-bearing MCP settlement.');
          sendToolCall(response, 'root-terminal', 'emit_result', { outcome: 'done', summary: 'MCP marker completed.' });
        } else throw new Error(`Unexpected root request ${rootCalls}.`);
      } catch (error) {
        fixtureFailure = error as Error;
        response.statusCode = 500; response.end();
      }
    });
    const providerPort = await listen(provider);
    let app: App | null = null;
    const nativeFetch = globalThis.fetch;
    try {
      const config = productionTestConfig(providerPort, (value) => {
        value.agents.executor = { ...value.agents.executor!, tools: ['write', 'mcp_tool_call'], skills: false };
        value.card_types.project = {
          permitted_child_types: [],
          records: { 'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true } },
          workflow: { format_version: 3,
            notification_recipient: 'executor',
            entries: { BACKLOG: { node: 'execute' }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: { reference: 'stopped-recovery', compactable: true } } },
            nodes: { execute: { execution: { kind: 'agent', agent: 'executor', prompt: { reference: 'execute', compactable: true }, correction_prompt: { reference: 'correct-execution-result', compactable: true } }, records: {}, edges: { done: { target: { terminal: 'DONE', promote: 'current', export_records: [] } } } } },
          },
        };
        value.mcpServers = { [SERVER_NAME]: { transport: 'streamable-http', url: `http://127.0.0.1:${mcpPort}`, disabled: false, autostart: true } };
      });
      writeProductionConfig(projectRoot, config);
      initializeProject(projectRoot);
      app = await startProductionApp(projectRoot, TOKEN);
      apps.add(app);
      expect(app.server.mcpManager.getServerCatalog(SERVER_NAME)?.tools).toEqual([
        expect.objectContaining({ name: 'echo_marker', inputSchema: expect.objectContaining({ type: 'object' }) }),
      ]);

      const started = await postStartProject(appOrigin(app), TOKEN);
      expect(started.status).toBe(200);
      expect(started.body.toolInvocations).toEqual([expect.objectContaining({ tool: 'start_project', params: {}, result: expect.objectContaining({ success: true }) })]);
      const cards = app.server.runtimeApplication.cardStore;
      try { await waitFor(() => cards.read('project')?.lifecycle.status === 'done', 'MCP-backed root completion'); }
      catch (error) {
        throw new Error(`${(error as Error).message} fixture=${(fixtureFailure as Error | null)?.message ?? 'none'} calls=${JSON.stringify({ analystCalls, rootCalls, mcpMethods, toolCalls })} tools=${JSON.stringify(app.server.mcpManager.getServerCatalog(SERVER_NAME)?.tools)} card=${JSON.stringify(cards.read('project')?.lifecycle)} conversation=${JSON.stringify(readConversation(projectRoot, 'agent:executor:project').physicalRows)}`);
      }

      if (fixtureFailure) throw fixtureFailure;
      expect(mcpMethods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
      expect(toolCalls).toEqual([{ name: 'echo_marker', arguments: { marker: MARKER } }]);
      const mappedMcpResult = [{ type: 'text', text: `echo:${MARKER}` }];
      const wrappedMcpResult = {
        result: { ...(isError === undefined ? {} : { isError }), _meta: { producer: 'synthetic-peer' } },
        native_content: [{ content_index: 0, type: 'text' }, ...(isError === true ? [{ content_index: 1, type: 'image', mimeType: 'image/png' }] : [])],
        ...(isError === true ? { content: mappedMcpResult } : {}),
      };
      const settlement = isError === true
        ? { success: false, error: 'MCP tool reported an error; effects may have occurred.', data: wrappedMcpResult }
        : { success: true, data: wrappedMcpResult, content: mappedMcpResult };
      expect(markerResultSeenByProvider).toEqual(settlement);
      expect(wrappedMcpResult).not.toHaveProperty('images');
      expect(JSON.stringify(settlement)).not.toContain('not selected');

      const conversation = readConversation(projectRoot, 'agent:executor:project').physicalRows;
      const mcpRows = conversation.filter((row) => row.tool === 'mcp_tool_call');
      expect(mcpRows.map((row) => row.kind)).toEqual(['tool_call', 'tool_result']);
      expect(mcpRows[1]).toMatchObject({ tool_call_id: 'mcp-call', context_policy: { kind: 'tool_result', settlement_origin: 'executed', evidence: { kind: 'none' } } });
      expect(JSON.parse(mcpRows[1]!.content)).toEqual(settlement);
      const query = new EventQueryService(projectRoot);
      const events = query.queryEvents({ kind: 'mcp_tool_invocation' }).events;
      expect(events).toEqual([
        expect.objectContaining({ kind: 'mcp_tool_invocation', server: SERVER_NAME, tool: 'echo_marker', success: isError !== true }),
      ]);
      expect(events[0]).not.toHaveProperty('error');
      expect(JSON.stringify(events)).not.toContain(MARKER);
      expect(JSON.stringify(events)).not.toContain('synthetic-peer');
      const stats = { total: 1, success: isError === true ? 0 : 1, error: isError === true ? 1 : 0 };
      expect(app.server.mcpManager.getInvocationStats()[`${SERVER_NAME}:echo_marker`]).toMatchObject(stats);
      expect(app.server.mcpManager.getToolsReadModel().servers).toEqual([
        expect.objectContaining({ name: SERVER_NAME, tools: [expect.objectContaining({ name: 'echo_marker', stats: expect.objectContaining(stats) })] }),
      ]);
      const headers = { authorization: `Bearer ${TOKEN}` };
      const statusResponse = await fetch(`${appOrigin(app)}/api/mcp/tools`, { headers });
      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toMatchObject({ servers: [expect.objectContaining({ tools: [expect.objectContaining({ stats: expect.objectContaining(stats) })] })] });
      expect((await fetch(`${appOrigin(app)}/api/debug/errors`)).status).toBe(401);
      const errorsResponse = await fetch(`${appOrigin(app)}/api/debug/errors`, { headers });
      expect(errorsResponse.status).toBe(200);
      const errors = await errorsResponse.json();
      const expectedErrors = { total: isError === true ? 1 : 0, errors: isError === true ? events : [] };
      expect(query.queryErrors()).toEqual(expectedErrors);
      expect(errors).toEqual(expectedErrors);
      if (isError === true) {
        // Vite resolves the browser's actual alias and extensionless imports, without
        // copying its projector into a backend test or changing production UI code.
        const browserModules = await createViteServer({
          configFile: false, root: resolve('web'),
          optimizeDeps: { noDiscovery: true, entries: [] },
          server: { middlewareMode: true },
          resolve: { alias: { '@saivage/schemas': resolve('src/schemas') } },
        });
        try {
          const { projectErrorRecord } = await browserModules.ssrLoadModule('/src/stores/debug-read-model.ts');
          expect(projectErrorRecord(errors.errors[0])).toMatchObject({
            id: events[0].id, source: `mcp:${SERVER_NAME}`, type: 'mcp_tool_invocation',
            severity: 'info', message: 'MCP tool echo_marker invocation failed',
          });
        } finally { await browserModules.close(); }
      }
      expect(cards.read('project')).toMatchObject({ lifecycle: { status: 'done', result: { summary: 'MCP marker completed.' } } });
      expect({ analystCalls, rootCalls }).toEqual({ analystCalls: 2, rootCalls: 2 });
    } finally {
      globalThis.fetch = nativeFetch;
      if (app) { apps.delete(app); await app.stop(); }
      await closeServer(provider);
      await closeServer(mcp);
    }
  }, 60_000);
});
