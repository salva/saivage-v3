import { describe, expect, it } from '@jest/globals';

import type { ToolInvocationProjectionInput } from '../../src/contracts/tool-invocation-projection.js';
import { parseConversationSessionId } from '../../src/schemas/index.js';
import {
  KNOWN_TOOL_INVOCATION_NAMES,
  projectToolInvocation,
  type KnownToolInvocationName,
} from '../../src/tools/tool-invocation-outbound.js';
import {
  credentialShapedCard,
  OUTBOUND_IDENTITY,
  OUTBOUND_RAW_MARKER,
  OUTBOUND_REDACTED_URL,
  OUTBOUND_TEXT_MARKER,
  OUTBOUND_URL,
} from '../helpers/outbound-identity-fixtures.js';

const sessionId = parseConversationSessionId('agent:planner:project');
const sourceInputId = '11111111-1111-4111-8111-111111111111';
const marker = `Authorization: Bearer ${OUTBOUND_RAW_MARKER}`;

const validArguments: Record<KnownToolInvocationName, unknown> = {
  create_card: { type: 'code', title: marker, bootstrap_content: marker, tags: [OUTBOUND_IDENTITY] },
  cancel_card: { cardId: 'card-a', reason: marker },
  delete_card: { ids: ['card-a'] },
  reorder_child: { parentId: 'project', orderedChildIds: ['card-a'] },
  queue_notification: { card_id: 'card-a', kind: 'tok_primary', body: marker },
  get_status: {}, start_project: {}, pause_runtime: {}, resume_runtime: {}, stop_project: {}, restart_server: {}, mcp_reconcile: {},
  navigate_workspace: { target: { kind: 'card', id: 'tok_primary', refinement: marker } },
  navigate_back: {}, show_config: {},
  reconfigure: { action: 'set_server_setting', key: 'host', value: 'tok_primary' },
  read_runtime_events: { limit: 1, kind: 'runtime_diagnostic' },
  read_runtime_errors: { limit: 1 },
  read_control_actions: { limit: 1, since: '2026-07-22T10:00:00.000Z' },
  list_processes_tool: { status: 'running', cardId: 'card-a' },
  list_agent_sessions: {}, read_agent_session: { sessionId: 'agent:planner:project', lastN: 1 },
  list_cards: { tag: OUTBOUND_IDENTITY }, get_card: { id: 'card-a' }, get_tree: { rootId: 'card-a' },
  list_card_history: { cardId: 'card-a' },
  get_card_history_entry: { cardId: 'card-a', version_seq: 1 },
  diff_card: { cardId: 'card-a', fromSeq: 1, toSeq: 2 },
  read: { path: 'project:///tok_primary', offset: 0, limit: 1 },
  write: { path: 'project:///tok_primary', content: marker },
  edit: { path: 'project:///tok_primary', old_string: marker, new_string: marker, replace_all: false },
  glob: { directory: 'project:///', pattern: marker, max_results: 1 },
  grep: { path: 'project:///', pattern: marker, include: '*.ts', max_results: 1 },
  apply_patch: { patch: marker },
  run_command: { command: marker, cwd: 'project:///', timeout_ms: 1, wait: false },
  wait_process: { process_id: 'tok_primary', timeout_ms: 1 },
  kill_process: { process_id: 'tok_primary' },
  websearch: { query: marker, max_results: 1 },
  webfetch: { url: OUTBOUND_URL, read_mode: 'text' },
  skill: { name: 'tok_primary' },
  mcp_tool_call: { serverName: 'ghu_server', toolName: 'rt_tool', args: { apiKey: OUTBOUND_RAW_MARKER, identity: 'stable_value' } },
  edit_card: { card_id: 'card-a', title: marker, tags: ['tok_primary'] },
  activate_card: { card_id: 'card-a' },
  emit_result: { outcome: 'tok_primary', summary: marker },
};

describe('projectToolInvocation exhaustive identity switch', () => {
  it('contains the exact 44-name baseline and every name reaches complete, call-row, and result-row', () => {
    expect(KNOWN_TOOL_INVOCATION_NAMES).toHaveLength(44);
    expect(new Set(KNOWN_TOOL_INVOCATION_NAMES).size).toBe(44);
    expect(Object.keys(validArguments).sort()).toEqual([...KNOWN_TOOL_INVOCATION_NAMES].sort());

    for (const toolName of KNOWN_TOOL_INVOCATION_NAMES) {
      const complete = projectToolInvocation({ shape: 'complete', identity: identity(toolName), arguments: validArguments[toolName], result: { success: false, error: marker } });
      expect(complete).toMatchObject({ shape: 'complete', identity: identity(toolName), result: { success: false } });
      expect(JSON.stringify(complete)).not.toContain(OUTBOUND_RAW_MARKER);

      const call = projectToolInvocation({ shape: 'call-row', identity: callIdentity(toolName), arguments: JSON.stringify(validArguments[toolName]) });
      expect(call).toMatchObject({ shape: 'call-row', identity: callIdentity(toolName) });
      expect(call).not.toHaveProperty('result');

      const result = projectToolInvocation({ shape: 'result-row', identity: identity(toolName), result: { success: false, error: marker } });
      expect(result).toMatchObject({ shape: 'result-row', identity: identity(toolName), result: { success: false } });
      expect(result).not.toHaveProperty('arguments');
      expect(JSON.stringify(result)).not.toContain(OUTBOUND_RAW_MARKER);
    }
  });

  it('preserves structural identities while classifying every valid argument group', () => {
    expect(complete('list_cards').arguments).toEqual({ tag: OUTBOUND_IDENTITY });
    expect(complete('reconfigure').arguments).toEqual({ action: 'set_server_setting', key: 'host', value: 'tok_primary' });
    expect(JSON.stringify(complete('create_card').arguments)).not.toContain(OUTBOUND_RAW_MARKER);
    expect(JSON.stringify(complete('write').arguments)).not.toContain(OUTBOUND_RAW_MARKER);
    expect(JSON.stringify(complete('run_command').arguments)).not.toContain(OUTBOUND_RAW_MARKER);
    expect(complete('webfetch').arguments).toEqual({ url: OUTBOUND_REDACTED_URL, read_mode: 'text' });
    expect(complete('mcp_tool_call').arguments).toEqual({ serverName: 'ghu_server', toolName: 'rt_tool', args: { apiKey: '[REDACTED]', identity: 'stable_value' } });
    expect(complete('emit_result').arguments).toMatchObject({ outcome: 'tok_primary' });
    expect(JSON.stringify(complete('emit_result').arguments)).not.toContain(OUTBOUND_RAW_MARKER);
  });

  it('classifies every reconfigure action/key/value branch without rewriting identities', () => {
    const cases = [
      { action: 'set_agent_model_route', agent: 'executor', model_route: 'executor' },
      { action: 'set_model_failover', for_model: 'sk-model', ordered_failover_models: ['tok_primary'] },
      { action: 'set_server_setting', key: 'port', value: 8080 },
      { action: 'set_server_setting', key: 'host', value: 'tok_primary' },
    ];
    for (const argumentsValue of cases) {
      const projected = projectToolInvocation({ shape: 'complete', identity: identity('reconfigure'), arguments: argumentsValue, result: { success: false, error: marker } });
      expect(projected.shape).toBe('complete');
      if (projected.shape !== 'complete') throw new Error('unexpected shape');
      expect((projected.arguments as Record<string, unknown>)['action']).toBe(argumentsValue.action);
    }
    expect(cases.map(({ action }) => action)).toEqual(['set_agent_model_route', 'set_model_failover', 'set_server_setting', 'set_server_setting']);
  });

  it('keeps unsupported, malformed-JSON, and schema-invalid-known calls readable on distinct paths', () => {
    const unsupported = projectToolInvocation({ shape: 'call-row', identity: callIdentity('future_tool'), arguments: JSON.stringify({ apiKey: 'synthetic-secret-value', id: 'stable_value' }) });
    expect(JSON.parse((unsupported as Extract<ToolInvocationProjectionInput, { shape: 'call-row' }>).arguments)).toEqual({ apiKey: '[REDACTED]', id: 'stable_value' });

    const malformed = projectToolInvocation({ shape: 'call-row', identity: callIdentity('webfetch'), arguments: `{${marker}` });
    expect((malformed as Extract<ToolInvocationProjectionInput, { shape: 'call-row' }>).arguments).not.toContain('synthetic-secret-value');

    const invalid = projectToolInvocation({ shape: 'call-row', identity: callIdentity('webfetch'), arguments: JSON.stringify({ apiKey: 'synthetic-secret-value', unexpected: 'stable_value' }) });
    expect(JSON.parse((invalid as Extract<ToolInvocationProjectionInput, { shape: 'call-row' }>).arguments)).toEqual({ apiKey: '[REDACTED]', unexpected: 'stable_value' });
    for (const projected of [unsupported, malformed, invalid]) expect(projected).not.toHaveProperty('result');
  });

  it('projects source-owned result leaves and invents neither calls nor arguments', () => {
    const webfetch = projectToolInvocation({
      shape: 'result-row', identity: identity('webfetch'),
      result: { success: true, data: { redacted_url: 'https://tok_primary.example/path?[REDACTED]', status: 200, headers: { etag: 'tok_primary' }, text: marker, bytes: 42, truncated: false } },
    });
    expect(JSON.stringify(webfetch)).not.toContain('synthetic-secret-value');
    expect(webfetch).not.toHaveProperty('arguments');

    const mcp = projectToolInvocation({ shape: 'result-row', identity: identity('mcp_tool_call'), result: { success: true, data: { apiKey: 'synthetic-secret-value', id: 'stable_value' } } });
    expect(mcp).toMatchObject({ result: { success: true, data: { apiKey: '[REDACTED]', id: 'stable_value' } } });

    const terminalFailure = projectToolInvocation({ shape: 'result-row', identity: identity('emit_result'), result: { success: false, error: marker, data: { apiKey: 'synthetic-secret-value', reason: 'stable_value' } } });
    expect(terminalFailure).toMatchObject({ result: { success: false, data: { apiKey: '[REDACTED]', reason: 'stable_value' } } });

    const workspace = projectToolInvocation({ shape: 'result-row', identity: identity('read'), result: { success: true, data: { path: 'project:///tok_primary', content: marker, total_lines: 1, truncated: false } } });
    expect(workspace).toMatchObject({ result: { success: true, data: { path: 'project:///tok_primary' } } });
    expect(JSON.stringify(workspace)).not.toContain('synthetic-secret-value');
  });

  it('keeps the shared tag filter and matching card result exact in every invocation shape', () => {
    const card = credentialShapedCard();
    const completeProjection = projectToolInvocation({
      shape: 'complete', identity: identity('list_cards'), arguments: { tag: OUTBOUND_IDENTITY },
      result: { success: true, data: [card] },
    });
    expect(completeProjection).toMatchObject({
      arguments: { tag: OUTBOUND_IDENTITY },
      result: { success: true, data: [{ id: 'card-token', tags: [OUTBOUND_IDENTITY], title: 'title token=[REDACTED]' }] },
    });
    expect(JSON.stringify(completeProjection)).not.toContain(OUTBOUND_RAW_MARKER);

    const callProjection = projectToolInvocation({
      shape: 'call-row', identity: callIdentity('list_cards'), arguments: JSON.stringify({ tag: OUTBOUND_IDENTITY }),
    });
    expect(JSON.parse((callProjection as Extract<ToolInvocationProjectionInput, { shape: 'call-row' }>).arguments)).toEqual({ tag: OUTBOUND_IDENTITY });
    expect(callProjection).not.toHaveProperty('result');

    const resultProjection = projectToolInvocation({
      shape: 'result-row', identity: identity('list_cards'), result: { success: true, data: [card] },
    });
    expect(resultProjection).toMatchObject({ result: { data: [{ tags: [OUTBOUND_IDENTITY] }] } });
    expect(resultProjection).not.toHaveProperty('arguments');
    expect(JSON.stringify(resultProjection)).not.toContain(OUTBOUND_RAW_MARKER);
  });

  it('keeps all rejected call forms shape-independent and never invents the absent side', () => {
    const cases = [
      { toolName: 'unsupported_tok_primary', arguments: { apiKey: OUTBOUND_RAW_MARKER, identity: OUTBOUND_IDENTITY } },
      { toolName: 'webfetch', arguments: { url: 7, apiKey: OUTBOUND_RAW_MARKER } },
    ] as const;
    for (const fixture of cases) {
      const completeProjection = projectToolInvocation({
        shape: 'complete', identity: identity(fixture.toolName), arguments: fixture.arguments,
        result: { success: false, error: OUTBOUND_TEXT_MARKER },
      });
      expect(completeProjection).toMatchObject({ shape: 'complete', identity: { toolName: fixture.toolName }, result: { success: false } });
      expect(JSON.stringify(completeProjection)).not.toContain(OUTBOUND_RAW_MARKER);

      const callProjection = projectToolInvocation({
        shape: 'call-row', identity: callIdentity(fixture.toolName), arguments: JSON.stringify(fixture.arguments),
      });
      expect(callProjection).not.toHaveProperty('result');
      expect(JSON.stringify(callProjection)).not.toContain(OUTBOUND_RAW_MARKER);

      const resultProjection = projectToolInvocation({
        shape: 'result-row', identity: identity(fixture.toolName), result: { success: false, error: OUTBOUND_TEXT_MARKER },
      });
      expect(resultProjection).not.toHaveProperty('arguments');
      expect(JSON.stringify(resultProjection)).not.toContain(OUTBOUND_RAW_MARKER);
    }

    const malformed = projectToolInvocation({
      shape: 'call-row', identity: callIdentity('webfetch'), arguments: `{${OUTBOUND_TEXT_MARKER}`,
    });
    expect(malformed).not.toHaveProperty('result');
    expect(JSON.stringify(malformed)).not.toContain(OUTBOUND_RAW_MARKER);
  });

  it('recursively supplies itself to the bounded read_agent_session result leaf', () => {
    const projected = projectToolInvocation({
      shape: 'result-row', identity: identity('read_agent_session'), result: { success: true, data: {
        session: { id: 'agent:planner:project', agent_name: 'planner', session_scope: 'card', card_id: 'project', status: 'inactive', started_at: '2026-07-22T10:00:00.000Z', model: 'sk-model' },
        activity_status: { status: 'inactive', pending_calls: [] }, total_messages: 1, returned: 1, parse_errors: 0,
        messages: [{
          id: `${sourceInputId}:tool-result:nested`, session_id: 'agent:planner:project', role: 'tool', kind: 'tool_result', tool: 'mcp_tool_call', tool_call_id: 'nested',
          content: JSON.stringify({ success: true, data: { apiKey: 'synthetic-secret-value', id: 'stable_value' } }), round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`,
          message_index: 0, block_index: 0, timestamp: '2026-07-22T10:00:00.000Z',
        }],
      } },
    });
    expect(JSON.stringify(projected)).not.toContain('synthetic-secret-value');
    expect(JSON.stringify(projected)).toContain('stable_value');
  });
});

function identity(toolName: string) {
  return { sessionId, sourceInputId, toolCallId: 'call-a', toolName };
}

function callIdentity(toolName: string) {
  return { ...identity(toolName), startedAt: '2026-07-22T10:00:00.000Z' };
}

function complete(toolName: KnownToolInvocationName): Extract<ToolInvocationProjectionInput, { shape: 'complete' }> {
  const projected = projectToolInvocation({ shape: 'complete', identity: identity(toolName), arguments: validArguments[toolName], result: { success: false, error: marker } });
  if (projected.shape !== 'complete') throw new Error('unexpected shape');
  return projected;
}
