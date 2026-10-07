import { describe, expect, it } from 'vitest';
import { presentToolCall, presentToolResult } from '../utils/tool-presenters';
import { TOOL_PRESENTERS } from '../utils/tool-presenters/presenters';
import { callEnvelope } from './tool-presenters/_helpers';
import { collection, slice } from './tool-presenters/fixtures';

const present = (tool: string, data: unknown, success = true) => presentToolResult(JSON.stringify(success ? { success, data } : { success, error: 'Recorded refusal', data }), { tool });
const details = (view: ReturnType<typeof present>) => JSON.stringify(view.sections);
const compact = { id: 'card-a', type: 'code', parent: 'project', status: 'stopped', title: 'Recorded title', depends_on: ['card-b'], priority: 0, urgency: 'normal' };
const draft = { card_id: 'card-a', name: 'brief.md', state: 'open', surface: 'card_agent', revision: 7, head_id: '11111111-1111-4111-8111-111111111111', current_url: 'record:///brief.md?card=card-a', accepted_version_url: 'record:///brief.md?card=card-a&v=4', bytes: 10, written: true };

describe('current family semantic authority', () => {
  it('exposes current Analyst CardView lifecycle, operator errors and partial propagation without adding Planner facts', () => {
    const analyst = present('reopen_card', {
      card: { id: 'card-a', type: 'code', title: 'Recorded Analyst title', depends_on: ['card-b'], priority: 0, urgency: 'normal', version_seq: 7, lifecycle: { status: 'changed', result: null, error: 'Recorded card failure', completed_at: null } },
      status: 'changed', parent: 'project', logical_path: '1',
      operator_summary: { blocked: false, hasError: true, error: 'Recorded card failure', completedAt: null, stale: true },
      propagation: { ok: false, partial: true, error: 'Known propagation failure' },
    });
    expect(analyst.outcome).toBe('changed');
    expect(JSON.stringify(analyst.headline)).toContain('Recorded card failure');
    expect(JSON.stringify(analyst.headline)).toContain('Known propagation failure');
    const summary = analyst.sections.find((s) => s.title === 'Recorded Analyst operator summary')!;
    expect(summary.fields?.map((f) => f.label)).toEqual(['blocked', 'hasError', 'error', 'completedAt', 'stale']);
    expect(analyst.sections.find((s) => s.title === 'Recorded card lifecycle')?.fields?.map((f) => f.label)).toEqual(['status', 'result', 'error', 'completed at']);
    const planner = present('create_card', { card: compact });
    expect(planner.sections.find((s) => s.title === 'Recorded Analyst operator summary')?.fields).toEqual([]);
    expect(details(planner)).not.toContain('version seq');
    expect(details(planner)).not.toContain('hasError');
  });
  it('keeps structured refusal qualifiers visible and selected error context accessible for every family', () => {
    const denied = present('create_card', { action: 'card.create', reason: 'wrong_state' }, false);
    expect(JSON.stringify(denied.headline)).toContain('reason: wrong_state');
    const context = denied.sections.find((s) => s.title === 'Recorded refusal / error context')!;
    expect(context.fields?.map((f) => f.label)).toEqual(['reason', 'action']);
    const missing = present('get_card_version', { code: 'card_version_not_found', card_id: 'card-a', version: 9 }, false);
    expect(JSON.stringify(missing.headline)).toContain('code: card_version_not_found');
    expect(details(missing)).toContain('card-a');
    expect(missing.sections.find((s) => s.title === 'Recorded refusal / error context')?.fields?.map((f) => f.label)).toEqual(['code', 'card id', 'version']);
    const unavailable = present('edit', { code: 'current_state_unavailable', resource: 'authored_record', owner_id: 'card-a:brief.md', operation: 'edit', restart_required: true }, false);
    expect(details(unavailable)).toContain('card-a:brief.md');
    expect(details(unavailable)).toContain('authored_record');
  });
  it('owns all 46 actual tools through one full-envelope presenter', () => {
    const names = ['activate_card','apply_patch','cancel_card','create_card','delete_card','diff_card_versions','edit','edit_card','emit_result','get_card','get_card_version','get_status','get_tree','glob','grep','kill_process','list_agent_sessions','list_card_versions','list_cards','list_processes_tool','mcp_tool_call','navigate_back','navigate_workspace','pause_runtime','queue_notification','read','read_agent_session','read_control_actions','read_record_version','read_runtime_errors','read_runtime_events','reconfigure','reorder_child','reopen_card','restart_server','resume_runtime','run_command','show_config','skill','start_project','stop_project','wait_process','webfetch','websearch','write'];
    names.push('view_image');
    expect(Object.keys(TOOL_PRESENTERS).sort()).toEqual(names.sort());
    for (const tool of names) {
      expect(TOOL_PRESENTERS[tool].result).toBeTypeOf('function');
      expect(presentToolCall(callEnvelope(tool, {})).sections.length).toBeGreaterThan(0);
    }
  });
  it('shows supplied edits and patches separately from measured effects', () => {
    const request = presentToolCall(callEnvelope('edit', { path: 'src/main.ts', old_string: 'before\n', new_string: 'after\n', replace_all: true }));
    expect(request.sections.map((s) => s.content).filter(Boolean)).toEqual(['before\n', 'after\n']);
    expect(JSON.stringify(request.sections)).toContain('not a full before/after snapshot');
    const edit = present('edit', { path: 'src/main.ts', replacements: 3, bytes: 50, edited: true });
    expect(edit.outcome).toBe('Applied');
    expect(details(edit)).toContain('replacements');
    expect(edit.headline).toEqual([{ kind: 'text', text: '3 replacements' }]);
    const patch = present('apply_patch', { changed_files: ['b.ts', 'a.ts'], applied: true });
    expect(patch.sections.find((s) => s.items)?.items?.map((s) => s.content)).toEqual(['b.ts', 'a.ts']);
    expect(details(present('write', { destination_kind: 'project_relative', target: 'out.txt', bytes: 5, written: true }))).toContain('out.txt');
  });
  it('distinguishes metadata, too-large content, text/path slices and partial collection items', () => {
    expect(present('read', { path: slice('project:///large'), metadata_only: true, size: 99 }).outcome).toBe('Metadata only');
    expect(details(present('read', { path: slice('project:///large'), metadata_only: true }))).toContain('Returned path slice');
    expect(present('read', { path: 'large', content: null, too_large: true, message: 'Not read inline' }).outcome).toContain('too large');
    expect(present('read', { path: 'notes', content: slice('exact\ntext', 4) }).sections.find((s) => s.title === 'Recorded content')?.content).toBe('exact\ntext');
    const fragment = { content_hex: '7b22', utf8_bytes: 2, offset_bytes: 0, next_offset_bytes: 2, total_bytes: 100 };
    const read = present('read', { entries: collection([fragment], 4) });
    expect(details(read)).toContain('not a complete observation');
    expect(read.sections.flatMap((s) => s.items ?? []).flatMap((s) => s.fields ?? []).flatMap((f) => f.parts).some((p) => p.kind === 'card')).toBe(false);
    expect(details(present('glob', { matches: collection(['src/a.ts']) }))).toContain('src/a.ts');
    expect(details(present('grep', { matches: collection([{ path: 'src/a.ts', line: 4, preview: 'needle' }]), content_truncated: true, max_line_chars: 2000 }))).toContain('needle');
  });
  it('uses compact Planner and nested Analyst facts without inventing revisions', () => {
    const planner = present('create_card', { card: compact });
    expect(details(planner)).toContain('Recorded title');
    expect(details(planner)).not.toContain('revision');
    expect(details(planner)).not.toContain('version seq');
    const analyst = present('create_card', { card: { ...compact, lifecycle: { status: 'stopped' }, version_seq: 3 }, status: 'stopped', parent: 'project' });
    expect(details(analyst)).toContain('version seq');
    expect(analyst.outcome).toBe('stopped');
    expect(present('reorder_child', { parent_id: 'project', changed: 0 }).outcome).toBe('Unchanged');
    expect(present('activate_card', { card_id: 'card-a', outcome: 'blocked', summary: 'Dependency missing', result: null }).outcome).toBe('blocked');
    const deleted = present('delete_card', { deleted: ['card-a-b', 'card-a'], top_level_deleted: ['card-a'] });
    expect(deleted.sections.find((s) => s.items)?.items?.map((s) => s.content)).toEqual(['card-a-b', 'card-a']);
  });
  it('keeps draft mutable revision 7 distinct from retained accepted v4 and partial acceptance', () => {
    const view = present('write', draft);
    expect(view.outcome).toBe('Draft updated');
    expect(details(view)).toContain('Retained accepted version');
    expect(details(view)).toContain('&v=4');
    expect(details(view)).toContain('Mutable revision');
    const accepted = present('edit', { ...draft, state: 'closed', surface: 'analyst', accepted_version_url: 'record:///brief.md?card=card-a&v=7', propagation: { ok: false, partial: true, error: 'Ancestor publication failed' } });
    expect(accepted.outcome).toBe('Record accepted');
    expect(accepted.headline[0]).toMatchObject({ text: expect.stringContaining('Partial propagation') });
    expect(accepted.headline[0]).toMatchObject({ text: expect.stringContaining('Ancestor publication failed') });
    const refused = present('edit', { code: 'record_open_conflict', card_id: 'card-a', name: 'brief.md', current_head: 7 }, false);
    expect(refused.status).toBe('error');
    expect(details(refused)).toContain('current head');
  });
  it.each(['pending_tool_settlement', 'suppressed', 'interrupted', 'not_requested', 'not_applicable'])('preserves notification %s without delivery claims', (status) => {
    const view = present('queue_notification', { queued: true, card_id: 'card-a', notification_id: 'notice', body: 'full body', interruption: { status, reason: 'owner unavailable', stopped_card_ids: ['card-a-b'] } });
    expect(view.outcome).toBe('Queued · Delivery not reported');
    expect(details(view)).toContain(status);
    expect(details(view)).toContain('card-a-b');
    expect(view.headline[0]).toMatchObject({ text: expect.stringContaining('owner unavailable') });
  });
  it('preserves queue refusal, control partial failure, confirmation and false containment', () => {
    expect(details(present('queue_notification', { queued: false, reason: 'activation_closed', card_id: 'card-a' }, false))).toContain('activation_closed');
    const start = present('start_project', { status: 'stopped', started: true, stopped: true }, false);
    expect(start.status).toBe('error');
    expect(details(start)).toContain('started');
    const restart = present('restart_server', { restart: 'confirmation_required', confirmationMessage: 'RESTART SERVER' });
    expect(restart.outcome).toBe('confirmation_required');
    expect(restart.headline[0]).toMatchObject({ text: 'RESTART SERVER' });
    expect(present('stop_project', { status: 'stopped', contained: false }).outcome).toBe('Stopped · Not contained');
    const proposed = presentToolCall(callEnvelope('emit_result', { outcome: 'done', summary: 'Proposed finish' }));
    expect(proposed.sections[0].title).toBe('Requested node result');
    expect(presentToolResult('{"success":true}', { tool: 'emit_result' }).outcome).toBe('Node result accepted');
    expect(present('emit_result', { code: 'stale_review' }, false).outcome).toBe('Failed');
  });
  it('exposes inspection, immutable diff/content, selected observation coverage and safe config sections', () => {
    expect(details(present('get_card', { card_id: 'card-a', section: 'summary', head_id: 'head', version_seq: 7, card: compact }))).toContain('Recorded title');
    expect(details(present('list_card_versions', { card_id: 'card-a', versions: collection([{ version: 2, change: { kind: 'edit' } }, { version: 9 }]) }))).toContain('immutable');
    expect(present('diff_card_versions', { card_id: 'card-a', from_version: 2, to_version: 9, diff: slice('exact diff') }).sections.find((s) => s.title === 'Recorded diff (text slice)')?.content).toBe('exact diff');
    expect(details(present('read_record_version', { card_id: 'card-a', version: 4, content: slice('old accepted'), content_source: 'accepted' }))).toContain('old accepted');
    expect(details(present('read_agent_session', { section: 'messages', total_visible_entries: 100, messages: collection([{ id: 'entry', content: 'selected message' }], 10) }))).toContain('selected message');
    expect(details(present('read_runtime_errors', { total_lines: 100, errors: collection([{ id: 'event', kind: 'runtime_diagnostic', timestamp: '2026-10-07T00:00:00Z', error_message: 'real error' }], 10) }))).toContain('Full line count');
    expect(details(present('read_control_actions', { total_lines: 100, returned: 1, actions: [{ id: 'audit', actor: 'analyst', surface: 'analyst_tool', action: 'pause', target_kind: 'runtime', target_id: null, params_summary: '', outcome: 'ok', outcome_summary: 'paused', created_at: '2026-10-07T00:00:00Z' }] }))).toContain('paused');
    expect(details(present('get_status', { runtimeSummary: { status: 'stopped' }, counts: { total: 3 } }))).toContain('stopped');
    expect(details(present('show_config', { config: { server: { port: 8080 }, models: { routes: { default: 'model' } }, agents: { analyst: {} }, providers: { safe: { apiKey: '[REDACTED]' } } } }))).toContain('Model routing');
    expect(present('reconfigure', { applied: true, action: 'set_server_setting', key: 'port', value: 8080, requires_restart: true }).outcome).toBe('Action applied');
  });
  it('exposes actual tree, process, session, selected-context and search item fields', () => {
    const tree = present('get_tree', { root_id: 'project', depth: 2, nodes: collection([{ ...compact, depth: 2, descendants: 1, depth_omitted: true }]) });
    expect(details(tree)).toContain('depth omitted');
    const processes = present('list_processes_tool', { processes: collection([{ id: 'proc-0123456789ab', command: 'npm test', status: 'running', cwd: '.', timed_out: false, exit_code: null, owner_kind: 'agent', owner_id: 'agent:executor:card-a', session_id: 'agent:executor:card-a', card_id: 'card-a', logs: { stdout: null, stderr: null } }]) });
    expect(details(processes)).toContain('npm test');
    const sessions = present('list_agent_sessions', { sessions: collection([{ id: 'agent:executor:card-a', agent_name: 'executor', session_scope: 'card', card_id: 'card-a', status: 'inactive', activity: 'idle', compaction: null, started_at: '2026-10-07T00:00:00Z' }]) });
    expect(details(sessions)).toContain('agent name');
    expect(sessions.sections.flatMap((s) => s.items ?? []).flatMap((s) => s.fields ?? []).flatMap((f) => f.parts)).toContainEqual({ kind: 'session', id: 'agent:executor:card-a', label: 'agent:executor:card-a' });
    const context = present('read_agent_session', { section: 'context', total_visible_entries: 100, has_segment_context: true, context: collection([{ kind: 'compacted', source_version: 2, summary_text: 'Retained context summary', protected_prompts: [], required_model_facts: {}, continuation: { kind: 'between_rounds' } }]) });
    expect(details(context)).toContain('Retained context summary');
    expect(details(context)).toContain('source version');
    const search = present('websearch', { query: 'query', results: [{ title: 'Recorded web title', url: 'https://example.test/', snippet: 'Returned excerpt' }] });
    expect(details(search)).toContain('Returned excerpt');
    const navigation = present('navigate_workspace', { intent: 'navigate_workspace', target: { kind: 'card', id: 'card-a' } });
    expect(details(navigation)).toContain('navigate_workspace');
    expect(navigation.headline[0]).toMatchObject({ text: 'Browser receipt not reported' });
    expect(details(present('cancel_card', { card_id: 'card-a', status: 'cancelled', cancelled_card_ids: ['card-a-b', 'card-a'] }))).toContain('card-a-b');
  });
  it('retains full-envelope uncertainty and rejects malformed public projections without green completion', () => {
    const unknown = present('write', { outcome_unknown: true, ...draft }, false);
    expect(unknown.outcome).toBe('Effects uncertain');
    expect(details(unknown)).toContain('Mutable revision');
    for (const raw of ['not json', 'null', '42', '{"success":true,"error":"bad"}', '{"success":false}', '{"success":true,"data":42}']) {
      const view = presentToolResult(raw, { tool: 'read' });
      expect(view.outcome).toBe('Presentation unavailable');
      expect(view.status).toBe('error');
    }
  });
});
