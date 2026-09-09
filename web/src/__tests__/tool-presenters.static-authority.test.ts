import { describe, expect, it } from 'vitest';
import { presentToolCall, presentToolResult } from '../utils/tool-presenters';
import { TOOL_PRESENTERS } from '../utils/tool-presenters/presenters';
import { buildToolDisplay, isKnownTool } from '../utils/tool-friendly';
import type { ToolPair } from '../utils/agent-timeline';
import { callEnvelope, inlineText } from './tool-presenters/_helpers';

// Oracle derived from provider-owned runtime tool specifications, autonomous
// emit_result composition, and the canonical generated Agent-tools table.
const CURRENT_TOOL_CALL_FIXTURES = {
  activate_card: { card_id: 'card-a' }, apply_patch: { patch: '*** Begin Patch' },
  cancel_card: { card_id: 'card-a', reason: 'done' },
  create_card: { type: 'code', title: 'Build', brief: 'Do it' },
  delete_card: { ids: ['card-a'] }, diff_card_versions: { card_id: 'card-a', from_version: 1, to_version: 2 },
  edit: { path: 'a.ts', old_string: 'a', new_string: 'b' }, edit_card: { card_id: 'card-a', title: 'New' },
  emit_result: { outcome: 'done', summary: 'complete' }, get_card: { id: 'card-a', section: 'summary' },
  get_card_version: { card_id: 'card-a', version: 2, section: 'summary' }, get_status: {}, get_tree: { rootId: 'card-a', depth: 2 },
  glob: { directory: '.', pattern: '**/*.ts' }, grep: { pattern: 'needle', path: 'src' }, kill_process: { process_id: 'proc-a' },
  list_agent_sessions: {}, list_card_versions: { card_id: 'card-a' }, list_cards: { status: ['backlog'], type: 'code', parent: 'project', tag: 'ui' },
  list_processes_tool: { status: 'running', cardId: 'card-a' }, mcp_reconcile: {},
  mcp_tool_call: { serverName: 'github', toolName: 'issues', args: { state: 'open' } }, navigate_back: {},
  navigate_workspace: { target: { kind: 'card', id: 'card-a', refinement: 'history' } }, pause_runtime: {},
  queue_notification: { card_id: 'card-a', kind: 'progress', body: 'Working' }, read: { path: 'README.md' },
  read_agent_session: { session_id: 'agent:executor:card-a', last_n: 5 }, read_control_actions: { limit: 10, since: '2026-07-21T00:00:00Z' },
  read_record_version: { card_id: 'card-a', record_name: 'status.md', version: 3 },
  read_runtime_errors: { limit: 10 }, read_runtime_events: { limit: 10, kind: 'card' }, reconfigure: { action: 'set_agent_model_route', agent: 'executor', model_route: 'executor' },
  reorder_child: { orderedChildIds: ['card-a', 'card-b'] }, reopen_card: { cardId: 'card-a' }, restart_server: {}, resume_runtime: {},
  run_command: { command: 'npm test', cwd: '.', wait: true }, show_config: {}, skill: { name: 'review' }, start_project: {}, stop_project: {},
  wait_process: { process_id: 'proc-a', timeout_ms: 1000 }, webfetch: { url: 'https://example.com' }, websearch: { query: 'saivage' },
  write: { path: 'a.ts', content: 'text' },
} satisfies Record<keyof typeof TOOL_PRESENTERS, Record<string, unknown>>;

const EXPECTED_NAMES = [
  'activate_card', 'apply_patch', 'cancel_card', 'create_card', 'delete_card', 'diff_card_versions', 'edit', 'edit_card', 'emit_result',
  'get_card', 'get_card_version', 'get_status', 'get_tree', 'glob', 'grep', 'kill_process', 'list_agent_sessions',
  'list_card_versions', 'list_cards', 'list_processes_tool', 'mcp_reconcile', 'mcp_tool_call', 'navigate_back', 'navigate_workspace',
  'pause_runtime', 'queue_notification', 'read', 'read_agent_session', 'read_control_actions', 'read_record_version', 'read_runtime_errors', 'read_runtime_events',
  'reconfigure', 'reopen_card', 'reorder_child', 'restart_server', 'resume_runtime', 'run_command', 'show_config', 'skill', 'start_project', 'stop_project',
  'wait_process', 'webfetch', 'websearch', 'write',
].sort();

const PLANNER_COMPACT_CARD = {
  id: 'card-p', type: 'code', parent: 'project', status: 'backlog', title: 'Planner',
  depends_on: [], related: [], tags: [], priority: 0, urgency: 'normal',
};

const ANALYST_CARD_VIEW = {
  card: {
    id: 'card-a', type: 'code', title: 'Analyst', child_membership: [], active_child_order: [], subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst',
    created_at: '2026-07-21T00:00:00.000Z', updated_at: '2026-07-21T00:00:00.000Z', version_seq: 1,
    assigned_to: null, depends_on: [], related: [], lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null,
  },
  logical_path: '1', status: 'backlog', parent: 'project',
  operator_summary: { blocked: false, hasError: false, error: null, completedAt: null, stale: false },
};

describe('static tool presenter authority', () => {
  it('contains exactly the 46 current tools with owned action and call rendering', () => {
    expect(Object.keys(TOOL_PRESENTERS).sort()).toEqual(EXPECTED_NAMES);
    expect(EXPECTED_NAMES).toHaveLength(46);
    for (const [name, descriptor] of Object.entries(TOOL_PRESENTERS)) {
      expect(descriptor.action.length).toBeGreaterThan(0);
      expect(Object.hasOwn(descriptor, 'call')).toBe(true);
      expect(typeof descriptor.call).toBe('function');
      const view = presentToolCall(callEnvelope(name, CURRENT_TOOL_CALL_FIXTURES[name as keyof typeof TOOL_PRESENTERS]));
      expect(view.icon).not.toBe('🔧');
    }
  });

  it('uses explicit current role variants and corrected fields', () => {
    expect(inlineText(presentToolCall(callEnvelope('cancel_card', { cardId: 'card-analyst' })).headline)).toContain('card-analyst');
    expect(inlineText(presentToolCall(callEnvelope('create_card', { type: 'code', parent: 'project', title: 'Analyst', brief: 'x' })).detail ?? [])).toContain('project');
    expect(inlineText(presentToolCall(callEnvelope('reorder_child', { parentId: 'project', orderedChildIds: ['card-b', 'card-a'] })).detail ?? [])).toContain('project');
    expect(inlineText(presentToolCall(callEnvelope('reopen_card', { cardId: 'card-a' })).headline)).toContain('card-a');
    expect(inlineText(presentToolCall(callEnvelope('activate_card', { card_id: 'card-current' })).headline)).toContain('card-current');
    expect(inlineText(presentToolCall(callEnvelope('edit_card', { card_id: 'card-current', title: 'x' })).headline)).toContain('card-current');
    expect(inlineText(presentToolCall(callEnvelope('queue_notification', { card_id: 'card-a', kind: 'progress', body: 'Current body' })).detail ?? [])).toContain('Current body');
    expect(inlineText(presentToolCall(callEnvelope('navigate_workspace', { target: { kind: 'card', id: 'card-a' } })).headline)).toBe('card · card-a');
    expect(inlineText(presentToolCall(callEnvelope('mcp_tool_call', { serverName: 's', toolName: 't' })).headline)).toBe('s/t');
  });

  it('keeps absent names generic and mcp_reconcile dedicated', () => {
    for (const name of ['move_card', 'get_card_output', 'add_note', 'list_notes', 'get_note', 'mark_note_handled']) {
      expect(isKnownTool(name)).toBe(false);
      expect(presentToolCall(callEnvelope(name, { id: 'old' })).icon).toBe('🔧');
    }
    expect(isKnownTool('mcp_reconcile')).toBe(true);
    expect(presentToolCall(callEnvelope('mcp_reconcile')).headline).toEqual([{ kind: 'text', text: 'retry MCP convergence from persisted configuration' }]);
    expect(presentToolCall(callEnvelope('mcp__github__issue', { title: 'x' })).icon).toBe('🔧');
  });

  it('parses only wrapped success data and supports optional data', () => {
    const textSlice = { content: 'a\nb', utf8_bytes: 3, offset_bytes: 0, next_offset_bytes: 3 };
    expect(inlineText(presentToolResult(JSON.stringify({ success: true, data: { total_bytes: 65536, content: textSlice } }), { tool: 'read' }).headline)).toBe('64.0 kB');
    expect(inlineText(presentToolResult(JSON.stringify({ success: true, data: { entries: { total: 40, position: { item_index: 0, item_byte_offset: 0 }, returned: 12, next: { item_index: 12, item_byte_offset: 0 }, items: [] } } }), { tool: 'read' }).headline)).toBe('12 of 40 entries');
    expect(inlineText(presentToolResult(JSON.stringify({ success: true, data: { cards: { total: 9, position: { item_index: 0, item_byte_offset: 0 }, returned: 3, next: null, items: [] } } }), { tool: 'list_cards' }).headline)).toBe('3 of 9 cards');
    expect(inlineText(presentToolResult(JSON.stringify({ success: true }), { tool: 'read' }).headline)).toBe('read completed');
    const unwrapped = presentToolResult(JSON.stringify({ stash_url: 'work:///tmp/stash/old.txt' }), { tool: 'webfetch' });
    expect(unwrapped.headline).toEqual([{ kind: 'text', text: 'result unavailable' }]);
    expect(unwrapped.headline[0]).not.toMatchObject({ kind: 'file' });
  });

  it('recognizes only the current result envelope and keeps all non-envelope bodies semantic-free', () => {
    const longError = `permission denied ${'x'.repeat(140)}`;
    const failureBody = { success: false, error: longError, data: { marker: 'failure-data-secret' } };
    const failure = presentToolResult(JSON.stringify(failureBody), { tool: 'read' });
    expect(failure).toMatchObject({ name: 'read', status: 'error', body: failureBody });
    expect(inlineText(failure.headline)).toHaveLength(120);
    expect(inlineText(failure.headline)).toContain('permission denied');
    expect(inlineText([...(failure.headline), ...(failure.detail ?? [])])).not.toContain('failure-data-secret');

    const malformed = [
      { content: JSON.stringify({ success: true, error: 'success-error-secret', data: { marker: 'success-data-secret' } }), tool: 'read' },
      { content: JSON.stringify({ success: false }), tool: 'read' },
      { content: JSON.stringify({ success: false, error: { message: 'non-string-error-secret' } }), tool: 'read' },
      { content: JSON.stringify({ tool: 'body-tool-secret', toolName: 'body-name-secret', marker: 'object-secret' }), tool: undefined },
      { content: JSON.stringify(['array-secret']), tool: 'read' },
      { content: JSON.stringify('json-string-secret'), tool: 'read' },
      { content: JSON.stringify(42), tool: 'read' },
      { content: JSON.stringify(true), tool: 'read' },
      { content: 'null', tool: 'read' },
      { content: 'plain-text-secret', tool: 'read' },
      { content: '{invalid-json-secret', tool: 'read' },
    ];
    for (const item of malformed) {
      const view = presentToolResult(item.content, { tool: item.tool });
      expect(view.status).toBe('ok');
      expect(view.name).toBe(item.tool ?? 'tool');
      expect(inlineText([...(view.headline), ...(view.detail ?? [])])).toBe('result unavailable');
    }
  });

  it('projects primitive data only through an intentional successful descriptor', () => {
    const wrapped = presentToolResult(JSON.stringify({ success: true, data: 42 }), { tool: 'mcp_tool_call' });
    const bare = presentToolResult(JSON.stringify(42), { tool: 'mcp_tool_call' });
    expect(inlineText(wrapped.headline)).toBe('42');
    expect(inlineText(bare.headline)).toBe('result unavailable');
  });

  it.each(['glob', 'grep'] as const)('uses one fixed successful %s headline while preserving opaque raw bodies', (tool) => {
    const call = presentToolCall(callEnvelope(tool, tool === 'glob' ? { directory: 'project:///src', pattern: '**/*.ts' } : { pattern: 'needle', path: 'project:///src' }));
    expect(TOOL_PRESENTERS[tool].group).toBe('context');
    expect(inlineText(call.headline)).toContain(tool === 'glob' ? 'project:///src' : 'needle');

    const bodies = [
      { success: true, data: { matches: { total: 0, position: { item_index: 0, item_byte_offset: 0 }, returned: 0, next: null, items: [] } } },
      { success: true, data: { matches: { total: 2, position: { item_index: 0, item_byte_offset: 0 }, returned: 1, next: { item_index: 1, item_byte_offset: 0 }, items: ['first'] } } },
      { success: true, data: { matches: { total: 1, position: { item_index: 0, item_byte_offset: 0 }, returned: 1, next: null, items: [{ content_hex: '2278', utf8_bytes: 2, offset_bytes: 0, next_offset_bytes: 2, total_bytes: 2 }] } } },
      { success: true, data: { matches: ['historical-a', 'historical-b'], truncated: true } },
    ];
    for (const body of bodies) {
      const view = presentToolResult(JSON.stringify(body), { tool });
      expect(inlineText(view.headline)).toBe(`${tool} completed`);
      expect(view.body).toEqual(body);
      expect(inlineText(view.headline)).not.toMatch(/\d+ match/u);
    }

    const failure = presentToolResult(JSON.stringify({ success: false, error: 'search failed' }), { tool });
    expect(failure.status).toBe('error');
    expect(inlineText(failure.headline)).toBe('search failed');
  });

  it('uses exact current process, card, and terminal result payloads', () => {
    const process = { process_id: 'proc-a', exit_code: 0, status: 'exited', stdout_url: 'work:///processes/proc-a/stdout.log', stderr_url: 'work:///processes/proc-a/stderr.log', stdout_bytes: 10, stderr_bytes: 0 };
    for (const tool of ['run_command', 'wait_process'] as const) {
      const view = presentToolResult(JSON.stringify({ success: true, data: process }), { tool });
      expect(inlineText(view.headline)).toContain('exit 0');
      expect(inlineText(view.detail ?? [])).toContain('proc-a');
    }
    expect(inlineText(presentToolResult(JSON.stringify({ success: true, data: [process] }), { tool: 'list_processes_tool' }).headline)).toBe('1 process');
    expect(inlineText(presentToolResult(JSON.stringify({ success: true, data: { card: PLANNER_COMPACT_CARD } }), { tool: 'create_card' }).headline)).toContain('card-p');
    expect(inlineText(presentToolResult(JSON.stringify({ success: true, data: ANALYST_CARD_VIEW }), { tool: 'create_card' }).headline)).toContain('card-a');
    const reopened = presentToolResult(JSON.stringify({ success: true, data: { ...ANALYST_CARD_VIEW, status: 'changed' } }), { tool: 'reopen_card' });
    expect(inlineText(reopened.headline)).toContain('card-a');
    expect(inlineText(reopened.detail ?? [])).toBe('changed');
    expect(inlineText(presentToolResult(JSON.stringify({ success: true, data: { card: { ...PLANNER_COMPACT_CARD, id: 'card-e', title: 'Edited' } } }), { tool: 'edit_card' }).headline)).toContain('card-e');
    const getCard = presentToolResult(JSON.stringify({ success: true, data: { card_id: 'card-a', version_seq: 1, section: 'summary', card: { id: 'card-a', type: 'code', status: 'backlog', title: 'Analyst' } } }), { tool: 'get_card' });
    expect(inlineText(getCard.headline)).toBe('Analyst');
    expect(inlineText(getCard.detail ?? [])).toBe('code · backlog');
    expect(inlineText(presentToolResult(JSON.stringify({ success: true, data: { card_id: 'card-a', outcome: 'blocked', summary: 'x', result: null } }), { tool: 'activate_card' }).headline)).toBe('blocked');
    expect(inlineText(presentToolResult(JSON.stringify({ success: true, data: { accepted: true } }), { tool: 'emit_result' }).headline)).toBe('result accepted');
  });

  it('renders queue success but keeps activation-closed failure on the generic failure boundary', () => {
    const successData = { queued: true, card_id: 'card-a', notification_id: 'notification-a' };
    const success = presentToolResult(JSON.stringify({ success: true, data: successData }), { tool: 'queue_notification' });
    expect(success.status).toBe('ok');
    expect(inlineText(success.headline)).toBe('notification queued');
    expect(success.body).toEqual({ success: true, data: successData });

    const error = "Cannot queue notification for card 'card-a': its current activation is closed to new notifications.";
    const failureData = { queued: false, reason: 'activation_closed', card_id: 'card-a' };
    const failure = presentToolResult(JSON.stringify({ success: false, error, data: failureData }), { tool: 'queue_notification' });
    expect(failure.status).toBe('error');
    expect(inlineText(failure.headline)).toBe(error);
    expect(inlineText(failure.headline)).not.toContain('notification queued');
    expect(failure.body).toEqual({ success: false, error, data: failureData });
    expect(failureData).not.toHaveProperty('status');
    expect(failureData).not.toHaveProperty('winner');
  });

  it('exposes wrapped canonical webfetch stash URLs as Files links', () => {
    const call = { id: 'c', session_id: 'agent:analyst:global', role: 'assistant', kind: 'tool_call', content: callEnvelope('webfetch', { url: 'https://example.com' }), context_policy: { kind: 'tool_call', template: { storage: 'durable', replacement: { kind: 'retain' }, settledAudience: 'primary_and_summarizer', evidenceMode: 'none' }, template_bytes: '{}', template_sha256: '0'.repeat(64) }, round_id: 'assistant:1', message_index: 0, block_index: 0, timestamp: '2026-07-21T00:00:00Z', tool: 'webfetch', tool_call_id: 'c' } as ToolPair['call'];
    const result = { ...call, id: 'r', role: 'tool', kind: 'tool_result', content: JSON.stringify({ success: true, data: { stash_url: 'work:///tmp/stash/webfetch.txt' } }), context_policy: { kind: 'tool_result', settlement_origin: 'executed', result_content_sha256: '0'.repeat(64), call_policy_sha256: '0'.repeat(64), evidence: { kind: 'none' } } } as ToolPair['result'];
    const display = buildToolDisplay({ call, result });
    expect(display.links).toContainEqual({ kind: 'file', root: 'output', path: '.saivage/work/tmp/stash/webfetch.txt', label: 'work:///tmp/stash/webfetch.txt' });
  });
});
