import { expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../../src/boot/app.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { deterministicRoundId } from '../../src/schemas/round-id-server.js';
import { EventQueryService } from '../../src/application/event-query-service.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { BoundAgentToolSet } from '../../src/tools/runtime-tool-catalog.js';
import { invokeToolForLlm } from '../../src/tools/invocation.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';
import {
  appOrigin, closeServer, createServer, initializeProject, listen, offeredToolNames,
  postStartProject, productionTestConfig, readJsonRequest, sendFinalMessage,
  sendToolCall, startProductionApp, waitFor, writeProductionConfig,
  type ChatCompletionRequest,
} from '../helpers/production-composition-e2e.js';

it.each([true, false])('restarts through ordinary production card composition (Executor control selected=%s), retaining old native facts and independent role authority', async executorControls => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-restart-production-'));
  const token = 'synthetic-restart-token';
  let app: App | undefined; let failure: unknown; let version = 'A'; let initializes = 0;
  const wire: string[] = []; const received: unknown[] = [];
  const mcp = createServer(async (req, res) => {
    try {
      const body = await readJsonRequest(req); wire.push(body.method);
      if (body.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
      res.setHeader('content-type', 'application/json');
      if (body.method === 'initialize') res.setHeader('Mcp-Session-Id', `restart-session-${++initializes}`);
      if (body.method === 'tools/call') received.push(body.params);
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list'
        ? { tools: [{ name: 'echo', description: `Catalog ${version}`, inputSchema: { type: 'object', properties: { value: { type: version === 'A' ? 'string' : 'integer' } }, required: ['value'], additionalProperties: false } }] }
        : body.method === 'tools/call' ? { content: [{ type: 'text', text: `known:${body.params.arguments.value}` }], _meta: { catalog: version, session: initializes } } : {} }));
    } catch (error) { failure = error; res.statusCode = 500; res.end(); }
  });
  let analyst = 0; let executor = 0; let reviewer = 0;
  let old: { bindingId: string; catalogId: string }; let fresh: typeof old;
  let preparedOldCall: object;
  let nativeA: unknown;
  const gateways = new Map<string, unknown>();
  const compositions = new Map<string, ChatCompletionRequest>();
  const provider = createServer(async (req, res) => {
    try {
      const body = await readJsonRequest(req) as ChatCompletionRequest;
      const names = offeredToolNames(body); const last = body.messages.at(-1);
      const result = last?.role === 'tool' ? JSON.parse(last.content) : null;
      const role = names.includes('start_project') ? 'analyst' : names.includes('write') && !names.includes('edit') ? 'executor' : 'reviewer';
      if (!gateways.has(role)) gateways.set(role, body.tools);
      else expect(body.tools).toEqual(gateways.get(role));
      compositions.set(role, body);
      const call = (id: string, tool: string, args: object) => sendToolCall(res, id, tool, args);
      const control = (id: string) => call(id, 'mcp_server_control', { serverName: 'local', action: 'restart' });
      const discover = () => call('discover-B', 'mcp_tools', { serverName: 'local' });
      const stale = () => call('stale-A', 'mcp_tool_call', preparedOldCall);
      const newCall = () => {
        expect(result).toMatchObject({ success: true, data: { tools: [{ description: 'Catalog B', inputSchema: { properties: { value: { type: 'integer' } } } }] } });
        fresh = result.data;
        expect(fresh.bindingId).not.toBe(old.bindingId); expect(fresh.catalogId).not.toBe(old.catalogId);
        call('call-B', 'mcp_tool_call', { serverName: 'local', bindingId: fresh.bindingId, catalogId: fresh.catalogId, toolName: 'echo', args: { value: 2 } });
      };
      if (role === 'analyst') {
        analyst++;
        if (analyst === 1) call('start', 'start_project', {});
        else { expect(result.success).toBe(true); sendFinalMessage(res, 'Started.'); }
      } else if (role === 'executor') {
        executor++;
        expect(names.includes('mcp_server_control')).toBe(executorControls);
        switch (executor) {
          case 1: call('discover-A', 'mcp_tools', { serverName: 'local' }); break;
          case 2:
            expect(result).toMatchObject({ success: true, data: { tools: [{ description: 'Catalog A' }] } }); old = result.data;
            preparedOldCall = { serverName: 'local', bindingId: old.bindingId, catalogId: old.catalogId, toolName: 'echo', args: { value: 'never-resend' } };
            call('call-A', 'mcp_tool_call', { serverName: 'local', bindingId: old.bindingId, catalogId: old.catalogId, toolName: 'echo', args: { value: 'A' } }); break;
          case 3:
            expect(result).toMatchObject({ success: true, data: { result: { _meta: { catalog: 'A', session: 1 } } }, content: [{ type: 'text', text: 'known:A' }] });
            nativeA = result; version = 'B'; control(executorControls ? 'restart' : 'denied-executor'); break;
          case 4:
            if (executorControls) { expect(result).toMatchObject({ success: true, data: { status: 'running', toolCount: 1 } }); stale(); }
            else {
              expect(result).toMatchObject({ success: false, error: expect.stringContaining('Unsupported executor tool call') });
              expect(initializes).toBe(1); expect(app!.server.mcpManager.getServerStatus('local')!.bindingId).toBe(old.bindingId);
              call('handoff', 'emit_result', { outcome: 'review', summary: 'Invocation does not confer control.' });
            } break;
          case 5: expect(result).toMatchObject({ success: false, error: expect.stringContaining('Stale MCP binding') }); discover(); break;
          case 6: newCall(); break;
          case 7: expect(JSON.stringify(result)).toContain('known:2'); call('handoff', 'emit_result', { outcome: 'review', summary: 'Fresh discovery and call complete.' }); break;
          default: throw new Error(`Unexpected Executor step ${executor}`);
        }
      } else {
        reviewer++;
        expect(names.includes('mcp_server_control')).toBe(!executorControls);
        if (executorControls) {
          if (reviewer === 1) control('denied-reviewer');
          else if (reviewer === 2) {
            expect(result).toMatchObject({ success: false, error: "Unsupported reviewer tool call 'mcp_server_control'." });
            expect(initializes).toBe(2); expect(app!.server.mcpManager.getServerStatus('local')!.bindingId).toBe(fresh.bindingId);
            call('done', 'emit_result', { outcome: 'approved', summary: 'Denied default Reviewer control before effects.' });
          } else throw new Error(`Unexpected Reviewer step ${reviewer}`);
        } else switch (reviewer) {
          case 1: control('restart'); break;
          case 2: expect(result).toMatchObject({ success: true, data: { status: 'running', toolCount: 1 } }); stale(); break;
          case 3: expect(result).toMatchObject({ success: false, error: expect.stringContaining('Stale MCP binding') }); discover(); break;
          case 4: newCall(); break;
          case 5: expect(JSON.stringify(result)).toContain('known:2'); call('done', 'emit_result', { outcome: 'approved', summary: 'Configured Reviewer used ordinary control.' }); break;
          default: throw new Error(`Unexpected Reviewer step ${reviewer}`);
        }
      }
    } catch (error) { failure = error; res.statusCode = 500; res.end(); }
  });
  try {
    const mcpPort = await listen(mcp); const providerPort = await listen(provider);
    writeProductionConfig(root, productionTestConfig(providerPort, config => {
      config.agents.executor = { ...config.agents.executor!, tools: ['write', 'mcp_tools', 'mcp_tool_call', ...(executorControls ? ['mcp_server_control'] : [])], skills: false };
      // Preserve default Reviewer selection in the denied scenario.
      if (!executorControls) config.agents.reviewer = { ...config.agents.reviewer!, tools: [...config.agents.reviewer!.tools, 'mcp_server_control', 'mcp_tools', 'mcp_tool_call'] };
      config.card_types.project = {
        permitted_child_types: [], records: { 'brief.md': { format: 'markdown', schema: 'card-brief.v1', bootstrap: true } },
        workflow: { format_version: 1,
          notification_recipient: 'executor',
          entries: { BACKLOG: { node: 'execute' }, CHANGED: { node: 'execute' }, BLOCKED: { node: 'execute' }, STOPPED: { node: 'execute', prompt: { reference: 'stopped-recovery', compactable: true } } },
          nodes: {
            execute: { execution: { kind: 'agent', agent: 'executor', prompt: { reference: 'execute', compactable: true }, correction_prompt: { reference: 'correct-execution-result', compactable: true } }, records: {}, edges: { review: { target: { node: 'review' } } } },
            review: { execution: { kind: 'agent', agent: 'reviewer', prompt: { reference: 'review', compactable: true }, correction_prompt: { reference: 'correct-review-result', compactable: true } }, records: {}, edges: { approved: { target: { terminal: 'DONE', promote: 'current', export_records: [] }, pending_notifications: { node: 'execute', prompt: { reference: 'stopped-recovery', compactable: true } } } } },
          },
        },
      };
      config.mcpServers = { local: { transport: 'streamable-http', url: `http://127.0.0.1:${mcpPort}`, autostart: true, disabled: false } };
    }));
    initializeProject(root); app = await startProductionApp(root, token);
    const oversight = compileProjectWorkflows(DEFAULT_SAIVAGE_CONFIG as never).oversight;
    const denied = new BoundAgentToolSet(oversight.tools.filter(tool => tool.name.startsWith('mcp_'))).bind({ scope: 'global', agentName: oversight.name, projectRoot: root, mcpToolInvocation: app.server.mcpManager } as never);
    const deniedOutcome = await invokeToolForLlm(denied, 'mcp_server_control', { serverName: 'local', action: 'restart' }, testLlmToolInvocationContext({ sessionId: 'agent:oversight:global', toolName: 'mcp_server_control' }));
    expect(deniedOutcome.kind).not.toBe('executed'); expect(initializes).toBe(1);
    expect((await postStartProject(appOrigin(app), token)).status).toBe(200);
    await waitFor(() => failure !== undefined || app!.server.runtimeApplication.cardStore.read('project')?.lifecycle.status === 'done', 'restart/permission completion');
    if (failure) throw failure;
    expect({ analyst, executor, reviewer }).toEqual({ analyst: 2, executor: executorControls ? 7 : 4, reviewer: executorControls ? 2 : 5 });
    expect(wire).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    expect(received).toEqual([{ name: 'echo', arguments: { value: 'A' } }, { name: 'echo', arguments: { value: 2 } }]);
    for (const [role, request] of compositions) {
      expect(request.messages.some(message => message.role === 'system')).toBe(true);
      if ((role === 'executor') === executorControls && role !== 'analyst') {
        const definitions = request.tools as Array<{ function: { name: string; parameters: unknown } }>;
        expect(definitions.find(tool => tool.function.name === 'mcp_server_control')!.function.parameters).toMatchObject({ properties: { action: { enum: ['start', 'stop', 'restart'] } }, additionalProperties: false });
      }
    }
    const rowsByRole = ['executor', 'reviewer'].map(role => readConversation(root, `agent:${role}:project`).physicalRows);
    for (const rows of rowsByRole) expect(rows.filter(row => row.kind === 'tool_result').map(row => row.tool_call_id)).toEqual(rows.filter(row => row.kind === 'tool_call').map(row => row.tool_call_id));
    const executorRows = rowsByRole[0]!;
    expect(JSON.parse(executorRows.find(row => row.kind === 'tool_result' && row.tool_call_id === 'discover-A')!.content)).toMatchObject({ success: true, data: { bindingId: old!.bindingId, catalogId: old!.catalogId, tools: [{ description: 'Catalog A', inputSchema: { properties: { value: { type: 'string' } } } }] } });
    expect(JSON.parse(executorRows.find(row => row.kind === 'tool_result' && row.tool_call_id === 'call-A')!.content)).toEqual(nativeA);
    const oldCall = JSON.parse(executorRows.find(row => row.kind === 'tool_call' && row.tool_call_id === 'call-A')!.content);
    expect(JSON.parse(oldCall.tool_calls[0].function.arguments)).toMatchObject({ bindingId: old!.bindingId, catalogId: old!.catalogId, args: { value: 'A' } });
    const events = new EventQueryService(root).queryEvents({ kind: 'mcp_tool_invocation' }).events;
    expect(events).toHaveLength(2);
    expect(events).toEqual([expect.objectContaining({ server: 'local', tool: 'echo', success: true }), expect.objectContaining({ server: 'local', tool: 'echo', success: true })]);
    const oldResult = executorRows.find(row => row.kind === 'tool_result' && row.tool_call_id === 'call-A')!;
    const oldRequest = executorRows.find(row => row.kind === 'tool_call' && row.tool_call_id === 'call-A')!;
    expect(oldResult.session_id).toBe(oldRequest.session_id);
    const sourceInputId = oldRequest.id.split(':tool-call:')[0]!;
    expect(oldResult.id.split(':tool-result:')[0]).toBe(sourceInputId);
    expect(oldRequest.round_id).toBe(deterministicRoundId('assistant', sourceInputId));
    expect(oldResult.round_id).toBe(deterministicRoundId('user', sourceInputId));
    expect(compositions.get('executor')!.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', tool_call_id: 'call-A', content: JSON.stringify(nativeA) })]));
    const evidence = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
    if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, `production-restart-${executorControls ? 'executor' : 'reviewer'}.json`), JSON.stringify({ compositions: Object.fromEntries(compositions), rowsByRole, events }, null, 2)); }
  } finally {
    try { await app?.stop(); }
    finally { try { await closeServer(provider); } finally { await closeServer(mcp); rmSync(root, { recursive: true }); } }
  }
}, 60_000);
