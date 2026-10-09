import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { pathToFileURL } from 'node:url';
import * as YAML from 'yaml';
import { McpManager } from '../../src/mcp/mcp-manager.js';
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
  it('serves lifetime workspace roots through a real synthetic stdio child and manager without replay', async () => {
    const projectRoot = mkdtempSync('/home/salva/g/ml/tmp/mcp-lifetime-á space-');
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
          manager.invokeTool('local', 'mutate', {}, { timeoutMs: 5000 }),
        ).resolves.toMatchObject({ content: [{ type: 'text', text: `mutation:${n}` }] });
      await expect(
        manager.invokeTool('local', 'report', {}, { timeoutMs: 5000 }),
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
        if (request.method === 'HEAD') { methods.push('HEAD'); response.end(); return; }
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
          expect(methods).toEqual(['HEAD', 'initialize']);
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
      expect(methods).toEqual(['HEAD', 'initialize', 'HEAD', 'initialize', 'notifications/initialized', 'tools/list']);
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
      expect(app.server.mcpManager.getServerTools(SERVER_NAME)).toEqual([]);
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
        if (request.method === 'HEAD') { mcpMethods.push('HEAD'); response.statusCode = 200; response.end(); return; }
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
          sendToolCall(response, 'mcp-call', 'mcp_tool_call', { serverName: SERVER_NAME, toolName: 'echo_marker', args: { marker: MARKER } });
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
          workflow: {
            notification_recipient: 'executor',
            entries: { BACKLOG: { node: 'execute' }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: { reference: 'stopped-recovery', compactable: true } } },
            nodes: { execute: { agent: 'executor', prompt: { reference: 'execute', compactable: true }, correction_prompt: { reference: 'correct-execution-result', compactable: true }, records: {}, edges: { done: { target: { terminal: 'DONE', promote: 'current', export_records: [] } } } } },
          },
        };
        value.mcpServers = { [SERVER_NAME]: { transport: 'streamable-http', url: `http://127.0.0.1:${mcpPort}`, disabled: false, autostart: true } };
      });
      writeProductionConfig(projectRoot, config);
      initializeProject(projectRoot);
      app = await startProductionApp(projectRoot, TOKEN);
      apps.add(app);
      expect(app.server.mcpManager.getServerTools(SERVER_NAME)).toEqual([
        expect.objectContaining({ name: 'echo_marker', inputSchema: expect.objectContaining({ type: 'object' }) }),
      ]);

      const started = await postStartProject(appOrigin(app), TOKEN);
      expect(started.status).toBe(200);
      expect(started.body.toolInvocations).toEqual([expect.objectContaining({ tool: 'start_project', params: {}, result: expect.objectContaining({ success: true }) })]);
      const cards = app.server.runtimeApplication.cardStore;
      try { await waitFor(() => cards.read('project')?.lifecycle.status === 'done', 'MCP-backed root completion'); }
      catch (error) {
        throw new Error(`${(error as Error).message} fixture=${(fixtureFailure as Error | null)?.message ?? 'none'} calls=${JSON.stringify({ analystCalls, rootCalls, mcpMethods, toolCalls })} tools=${JSON.stringify(app.server.mcpManager.getServerTools(SERVER_NAME))} card=${JSON.stringify(cards.read('project')?.lifecycle)} conversation=${JSON.stringify(readConversation(projectRoot, 'agent:executor:project').physicalRows)}`);
      }

      if (fixtureFailure) throw fixtureFailure;
      expect(mcpMethods).toEqual(['HEAD', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
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
