import { expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../../src/boot/app.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { recordObservationFactsText } from '../../src/runtime/actors/context/composition-projector.js';
import { EventQueryService } from '../../src/application/event-query-service.js';
import {
  appOrigin, closeServer, createServer, initializeProject, listen, offeredToolNames,
  postStartProject, productionTestConfig, readJsonRequest, sendFinalMessage,
  sendToolCall, startProductionApp, waitFor, writeProductionConfig,
  type ChatCompletionRequest,
} from '../helpers/production-composition-e2e.js';

function expectedSettlement(body: ChatCompletionRequest, root: string, session: Parameters<typeof readConversation>[1], id: string, name: string, args: object) {
  const calls = body.messages.filter(message => message.tool_calls?.some(call => (call as { id: string }).id === id));
  const results = body.messages.filter(message => message.role === 'tool' && message.tool_call_id === id);
  expect(calls).toHaveLength(1); expect(results).toHaveLength(1);
  expect(calls[0]).toMatchObject({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  expect(calls[0]!.tool_calls).toHaveLength(1);
  const index = body.messages.indexOf(results[0]!);
  expect(index).toBe(body.messages.indexOf(calls[0]!) + 1);
  const conversation = readConversation(root, session);
  const facts = conversation.effectiveRequiredModelFacts.latestRecordObservations.map(fact => ({ ...fact,
    source: conversation.sourceRows.some(row => row.id === fact.source.messageId) ? { messageId: fact.source.messageId, timestamp: fact.source.timestamp } : fact.source,
  }));
  expect(body.messages.slice(index + 1)).toEqual(facts.length ? [{ role: 'system', content: recordObservationFactsText(facts) }] : []);
  return results[0]!;
}

it('uses ordinary opted-in card refresh with frozen gateways, retained observations and a newly denied Reviewer surface', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-refresh-production-'));
  const token = 'local-refresh-e2e-token';
  let app: App | undefined; let failure: unknown; let version = 'A';
  const wire: string[] = []; const received: unknown[] = [];
  const mcp = createServer(async (req, res) => {
    try {
      const body = await readJsonRequest(req); wire.push(body.method);
      if (body.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
      res.setHeader('content-type', 'application/json');
      if (body.method === 'initialize') res.setHeader('Mcp-Session-Id', 'production-refresh-session');
      if (body.method === 'tools/call') received.push(body.params);
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list'
        ? { tools: [{ name: 'echo', description: `Catalog ${version}`, inputSchema: { type: 'object', properties: { value: { type: version === 'A' ? 'string' : 'integer' } }, required: ['value'], additionalProperties: false } }] }
        : body.method === 'tools/call' ? { content: [{ type: 'text', text: `known:${body.params.arguments.value}` }] } : {} }));
    } catch (error) { failure = error; res.statusCode = 500; res.end(); }
  });
  let analyst = 0; let executor = 0; let reviewer = 0;
  let old: { bindingId: string; catalogId: string };
  let fresh: { bindingId: string; catalogId: string };
  let gateway: unknown;
  // These are actual production-serialized offline compositions, not reconstructed prompts.
  const compositions = new Map<string, ChatCompletionRequest>();
  const pending = new Map<string, { id: string; name: string; args: object }>();
  const provider = createServer(async (req, res) => {
    try {
      const body = await readJsonRequest(req) as ChatCompletionRequest;
      const names = offeredToolNames(body);
      const role = names.includes('start_project') ? 'analyst' : names.includes('mcp_catalog_refresh') ? 'executor' : 'reviewer';
      const expected = pending.get(role);
      const result = expected ? JSON.parse(expectedSettlement(body, root, role === 'analyst' ? 'agent:analyst:global' : `agent:${role}:project`, expected.id, expected.name, expected.args).content) : null;
      pending.delete(role);
      const call = (id: string, name: string, args: object) => { pending.set(role, { id, name, args }); sendToolCall(res, id, name, args); };
      if (names.includes('start_project')) {
        compositions.set('global Analyst', body); analyst++;
        expect(names).not.toContain('mcp_catalog_refresh');
        if (analyst === 1) call('start', 'start_project', {});
        else { expect(result.success).toBe(true); sendFinalMessage(res, 'Started.'); }
      } else if (names.includes('mcp_catalog_refresh')) {
        compositions.set('opted-in card Executor', body); executor++;
        if (gateway === undefined) gateway = body.tools;
        else expect(body.tools).toEqual(gateway);
        switch (executor) {
          case 1: call('discover-A', 'mcp_tools', { serverName: 'local' }); break;
          case 2:
            expect(result).toMatchObject({ success: true, data: { tools: [{ description: 'Catalog A' }] } });
            old = result.data;
            call('call-A', 'mcp_tool_call', { serverName: 'local', bindingId: old.bindingId, catalogId: old.catalogId, toolName: 'echo', args: { value: 'A' } }); break;
          case 3:
            expect(JSON.stringify(result)).toContain('known:A'); version = 'B';
            call('refresh-B', 'mcp_catalog_refresh', { serverName: 'local', bindingId: old.bindingId }); break;
          case 4:
            expect(result).toMatchObject({ success: true, data: { serverName: 'local', bindingId: old.bindingId, toolCount: 1 } });
            expect(result.data.catalogId).not.toBe(old.catalogId);
            call('stale-A', 'mcp_tool_call', { serverName: 'local', bindingId: old.bindingId, catalogId: old.catalogId, toolName: 'echo', args: { value: 'A' } }); break;
          case 5:
            expect(result).toMatchObject({ success: false, error: expect.stringContaining('Stale MCP catalog') });
            call('discover-B', 'mcp_tools', { serverName: 'local' }); break;
          case 6:
            expect(result).toMatchObject({ success: true, data: { bindingId: old.bindingId, tools: [{ description: 'Catalog B', inputSchema: { properties: { value: { type: 'integer' } } } }] } });
            fresh = result.data;
            call('call-B', 'mcp_tool_call', { serverName: 'local', bindingId: fresh.bindingId, catalogId: fresh.catalogId, toolName: 'echo', args: { value: 2 } }); break;
          case 7:
            expect(JSON.stringify(result)).toContain('known:2');
            call('handoff', 'emit_result', { outcome: 'review', summary: 'Catalog refreshed and new call observed.' }); break;
          default: throw new Error(`Unexpected Executor step ${executor}`);
        }
      } else {
        compositions.set('denied card Reviewer', body); reviewer++;
        expect(names).not.toContain('mcp_tool_call'); expect(names).not.toContain('mcp_tools');
        if (reviewer === 1) call('denied-refresh', 'mcp_catalog_refresh', { serverName: 'local', bindingId: fresh.bindingId });
        else if (reviewer === 2) {
          expect(result).toMatchObject({ success: false, error: "Unsupported reviewer tool call 'mcp_catalog_refresh'." });
          call('denied-call', 'mcp_tool_call', { serverName: 'local', bindingId: fresh.bindingId, catalogId: fresh.catalogId, toolName: 'echo', args: { value: 3 } });
        } else if (reviewer === 3) {
          expect(result).toMatchObject({ success: false, error: "Unsupported reviewer tool call 'mcp_tool_call'." });
          call('done', 'emit_result', { outcome: 'approved', summary: 'Denied surface retained independent permissions.' });
        } else throw new Error(`Unexpected Reviewer step ${reviewer}`);
      }
    } catch (error) { failure = error; res.statusCode = 500; res.end(); }
  });
  try {
    const mcpPort = await listen(mcp); const providerPort = await listen(provider);
    writeProductionConfig(root, productionTestConfig(providerPort, config => {
      config.agents.executor = { ...config.agents.executor!, tools: ['write', 'mcp_tools', 'mcp_catalog_refresh', 'mcp_tool_call'], skills: false };
      config.agents.reviewer = { ...config.agents.reviewer!, tools: ['read', 'write'], skills: false };
      config.card_types.project = {
        permitted_child_types: [], records: { 'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true } },
        workflow: { format_version: 5,
          notification_recipient: 'executor',
          entries: { BACKLOG: { node: 'execute' }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: { reference: 'stopped-recovery', compactable: true } } },
          nodes: {
            execute: { execution: { kind: 'agent', agent: 'executor', prompt: { reference: 'execute', compactable: true }, correction_prompt: { reference: 'correct-execution-result', compactable: true } }, records: {}, edges: { review: { target: { node: 'review' } } } },
            review: {
              execution: { kind: 'agent', agent: 'reviewer',
              prompt: { reference: 'review', compactable: true },
              correction_prompt: { reference: 'correct-review-result', compactable: true } },
              records: {},
              edges: {
                approved: {
                  target: { terminal: 'DONE', promote: 'current', export_records: [] },
                  // Nonrecipient completion must return pending context to the same
                  // Executor that owns STOPPED recovery. This scenario queues none.
                  pending_notifications: { node: 'execute', prompt: { reference: 'stopped-recovery', compactable: true } },
                },
              },
            },
          },
        },
      };
      config.mcpServers = { local: { transport: 'streamable-http', url: `http://127.0.0.1:${mcpPort}`, autostart: true, disabled: false } };
    }));
    initializeProject(root); app = await startProductionApp(root, token);
    expect((await postStartProject(appOrigin(app), token)).status).toBe(200);
    await waitFor(() => failure !== undefined || app!.server.runtimeApplication.cardStore.read('project')?.lifecycle.status === 'done', 'refresh/denied-role completion');
    if (failure) throw failure;
    expect({ analyst, executor, reviewer }).toEqual({ analyst: 2, executor: 7, reviewer: 3 });
    expect(wire).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'tools/list', 'tools/call']);
    expect(received).toEqual([{ name: 'echo', arguments: { value: 'A' } }, { name: 'echo', arguments: { value: 2 } }]);
    const definitions = gateway as Array<{ function: { name: string; parameters: unknown } }>;
    const parameters = (name: string) => definitions.find(tool => tool.function.name === name)!.function.parameters;
    expect(parameters('mcp_tool_call')).toMatchObject({ required: expect.arrayContaining(['bindingId', 'catalogId']), additionalProperties: false });
    expect(parameters('mcp_catalog_refresh')).toMatchObject({ required: ['serverName', 'bindingId'], additionalProperties: false });
    expect(compositions.size).toBe(3);
    for (const composition of compositions.values()) {
      expect(composition.messages.filter(message => message.role === 'system').length).toBeGreaterThan(0);
      expect(JSON.stringify(composition.messages.filter(message => message.role === 'system'))).not.toContain('{{contractDescription}}');
    }
    const executorRows = readConversation(root, 'agent:executor:project').physicalRows;
    const calls = executorRows.filter(row => row.kind === 'tool_call');
    const results = executorRows.filter(row => row.kind === 'tool_result');
    expect(calls.map(row => row.tool_call_id)).toEqual(['discover-A', 'call-A', 'refresh-B', 'stale-A', 'discover-B', 'call-B', 'handoff']);
    expect(results.map(row => row.tool_call_id)).toEqual(calls.map(row => row.tool_call_id));
    expect(JSON.parse(results.find(row => row.tool_call_id === 'refresh-B')!.content)).toMatchObject({ success: true, data: { bindingId: old!.bindingId, catalogId: fresh!.catalogId, toolCount: 1 } });
    expect(JSON.parse(results.find(row => row.tool_call_id === 'stale-A')!.content)).toMatchObject({ success: false, error: expect.stringContaining('not dispatched') });
    const denied = readConversation(root, 'agent:reviewer:project').physicalRows.filter(row => row.kind === 'tool_result' && row.tool !== 'emit_result');
    expect(denied).toHaveLength(2);
    expect(denied.map(row => ({ toolCallId: row.tool_call_id, result: JSON.parse(row.content) }))).toEqual([
      { toolCallId: 'denied-refresh', result: { success: false, error: "Unsupported reviewer tool call 'mcp_catalog_refresh'." } },
      { toolCallId: 'denied-call', result: { success: false, error: "Unsupported reviewer tool call 'mcp_tool_call'." } },
    ]);
    expect(new EventQueryService(root).queryEvents({ kind: 'mcp_tool_invocation' }).events).toHaveLength(2);
    expect(app.server.mcpManager.getInvocationStats()['local:echo']).toMatchObject({ total: 2, success: 2, error: 0 });
  } finally {
    try { await app?.stop(); }
    finally { try { await closeServer(provider); } finally { await closeServer(mcp); rmSync(root, { recursive: true }); } }
  }
}, 60_000);
