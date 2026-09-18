import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  it('discovers and calls a streamable-HTTP tool through authenticated Analyst start and persists the settled result', async () => {
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
          response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `echo:${body.params.arguments.marker}` }] } }));
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
    // Real undici JSON values cross Jest's VM realm; reparse response text in this realm so
    // the production MCP validator sees the same ordinary objects it receives outside Jest.
    globalThis.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      Object.defineProperty(response, 'json', { value: async () => JSON.parse(await response.text()) });
      return response;
    };
    try {
      initializeProject(projectRoot);
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
      const wrappedMcpResult = { result: mappedMcpResult, result_complete: true, result_utf8_bytes: Buffer.byteLength(JSON.stringify(mappedMcpResult), 'utf8') };
      expect(markerResultSeenByProvider).toEqual({ success: true, data: wrappedMcpResult });

      const conversation = readConversation(projectRoot, 'agent:executor:project').physicalRows;
      const mcpRows = conversation.filter((row) => row.tool === 'mcp_tool_call');
      expect(mcpRows.map((row) => row.kind)).toEqual(['tool_call', 'tool_result']);
      expect(mcpRows[1]).toMatchObject({ tool_call_id: 'mcp-call', context_policy: { kind: 'tool_result', settlement_origin: 'executed', evidence: { kind: 'none' } } });
      expect(JSON.parse(mcpRows[1]!.content)).toEqual({ success: true, data: wrappedMcpResult });
      expect(new EventQueryService(projectRoot).queryEvents({ kind: 'mcp_tool_invocation' }).events).toEqual([
        expect.objectContaining({ kind: 'mcp_tool_invocation', server: SERVER_NAME, tool: 'echo_marker', success: true }),
      ]);
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
