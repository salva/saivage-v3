import { describe, expect, it } from 'vitest';
import { buildToolDisplay, inlinePartsText, isKnownTool } from '../utils/tool-friendly';
import { call, result, processData } from './tool-presenters/fixtures';
import { presentToolResult } from '../utils/tool-presenters';
describe('single row tool display', () => {
  it('combines the observed outcome with its request, without stdout in the default', () => {
    const c = call('run_command', { command: 'npm test' });
    const r = result('run_command', { ...processData, exit_code: 1 });
    const requested = buildToolDisplay({ entry: c, mate: r });
    expect(requested.action).toBe('Run command');
    expect(requested.statusTone).toBe('error');
    expect(inlinePartsText(requested.status)).toContain('Process failed · exit 1');
    expect(inlinePartsText(requested.status)).not.toContain('stdout');
    expect(requested.requestSections!.length).toBeGreaterThan(0);
    expect(requested.resultSections!.length).toBeGreaterThan(0);
    const recorded = buildToolDisplay({ entry: r, mate: c });
    expect(recorded.action).toBe('Result · Run command');
    expect(inlinePartsText(recorded.status)).toContain('Process failed · exit 1');
    expect(recorded.statusTone).toBe('error');
    expect(inlinePartsText(recorded.target)).toContain('npm test');
  });
  it('renders unmatched calls and retained results honestly', () => {
    expect(inlinePartsText(buildToolDisplay({ entry: call('read'), mate: null }).status)).toBe('No result recorded');
    const recorded = buildToolDisplay({ entry: result('read', { metadata_only: true }), mate: null });
    expect(inlinePartsText(recorded.target)).toBe('Requested context unavailable');
    expect(inlinePartsText(recorded.status)).toContain('Metadata only');
  });
  it('keeps exact unknown tool names and opaque safe values', () => {
    expect(isKnownTool('custom_probe')).toBe(false);
    const display = buildToolDisplay({ entry: call('custom_probe', { exact: 'received' }), mate: null });
    expect(display.toolName).toBe('custom_probe');
    expect(display.requestSections[0].content).toContain('received');
  });
  it('bounds the combined command target, not its detail, and leaves a short command exact', () => {
    const command = `npm test -- ${'long_unbroken_argument_'.repeat(200)}FINAL-COMMAND`;
    const c = call('run_command', { command });
    const display = buildToolDisplay({ entry: c, mate: result('run_command', processData) });
    const target = inlinePartsText(display.target);
    expect(target.length).toBeLessThanOrEqual(48);
    expect(target).toContain('npm test -- long_unbroken_argument_');
    expect(target.endsWith('…')).toBe(true);
    expect(display.requestSections.find(section => section.title === 'command')?.content).toBe(command);
    expect(inlinePartsText(display.status)).toBe('Exited · exit 0 · Output head incomplete');
    expect(inlinePartsText(buildToolDisplay({ entry: call('run_command', { command: 'npm test' }), mate: null }).target)).toBe('npm test');
    expect(JSON.parse(c.content).tool_calls[0].function.arguments).toContain('FINAL-COMMAND');
  });
  it('keeps distinct long path filenames and exact single-target link authority', () => {
    const targets = ['first-observation.png', 'second-observation.png'].map(filename => {
      const path = `work:///tmp/${'shared-parent/'.repeat(50)}${filename}`;
      const display = buildToolDisplay({ entry: call('read', { path }), mate: null });
      const target = inlinePartsText(display.target);
      expect(target.length).toBeLessThanOrEqual(48);
      expect(target).toContain('work:///tmp/');
      expect(target).toContain(filename);
      expect(display.links[0]).toMatchObject({ kind: 'file', path: `.saivage/work/tmp/${'shared-parent/'.repeat(50)}${filename}` });
      expect(JSON.stringify(display.requestSections)).toContain(path);
      return target;
    });
    expect(targets[0]).not.toBe(targets[1]);
  });
  it.each(['glob', 'grep'])('shares one budget between the %s query and scope with a visible separator', tool => {
    const pattern = `meaningful-query-${'x'.repeat(1000)}`;
    const path = `work:///tmp/${'parent/'.repeat(100)}scope.ts`;
    const display = buildToolDisplay({ entry: call(tool, { pattern, path, directory: path }), mate: null });
    const target = inlinePartsText(display.target);
    expect(target.length).toBeLessThanOrEqual(48);
    expect(target).toContain('meaningful-query-');
    expect(target).toContain(' · ');
    expect(target).toContain('scope.ts');
    expect(JSON.stringify(display.requestSections)).toContain(pattern);
    expect(JSON.stringify(display.requestSections)).toContain(path);
    expect(display.links).toHaveLength(1);
  });
  it('keeps URL host and identifying tail, and moves the complete query into direct detail', () => {
    const url = `https://example.test/${'shared/'.repeat(100)}reference.html?query=${'q'.repeat(1000)}FINAL-QUERY`;
    const display = buildToolDisplay({ entry: call('webfetch', { url }), mate: null });
    const target = inlinePartsText(display.target);
    expect(target.length).toBeLessThanOrEqual(48);
    expect(target).toContain('example.test');
    expect(target).toContain('reference.html');
    expect(target).not.toContain('query=');
    expect(target.endsWith('…')).toBe(true);
    expect(JSON.stringify(display.requestSections)).toContain(url);
  });
  it.each(['delete_card', 'reorder_child'])('summarizes %s lists as count plus a representative, preserving every supplied ID', tool => {
    const ids = ['card-a', ...Array.from({ length: 80 }, (_, i) => `card-${'a'.repeat(i + 2)}`)];
    const display = buildToolDisplay({ entry: call(tool, { ids, orderedChildIds: ids }), mate: null });
    expect(inlinePartsText(display.target)).toBe(`${ids.length} ${tool === 'delete_card' ? 'roots' : 'children'} · card-a`);
    expect(display.links).toHaveLength(0);
    for (const id of ids) expect(JSON.stringify(display.requestSections)).toContain(id);
  });
  it.each([
    ['emit_result', { outcome: 'done', summary: 'full-summary-'.repeat(100) }, 'done'],
    ['navigate_workspace', { target: { kind: 'transcript', id: 'agent:executor:card-a' } }, 'transcript · agent:executor:card-a'],
    ['navigate_workspace', { target: { kind: 'card', id: 'card-a', refinement: 'records' } }, 'card · card-a · records'],
    ['navigate_workspace', { target: { kind: 'process_list', refinement: 'running' } }, 'process_list · running'],
    ['reconfigure', { action: 'set_server_setting', key: 'port', value: 8080 }, 'set_server_setting · port'],
  ] as const)('uses structured %s selections, not summary prose or serialized JSON', (tool, args, target) => {
    const display = buildToolDisplay({ entry: call(tool, args), mate: null });
    expect(inlinePartsText(display.target)).toBe(target);
    expect(display.requestSections).not.toHaveLength(0);
  });
  it('bounds custom action/opaque target without changing exact name or JSON detail', () => {
    const name = `custom_${'n'.repeat(200)}`;
    const args = { opaque: 'o'.repeat(2000) };
    const display = buildToolDisplay({ entry: call(name, args), mate: null });
    expect(display.action.length).toBeLessThanOrEqual(48);
    expect(inlinePartsText(display.target).length).toBeLessThanOrEqual(48);
    expect(display.toolName).toBe(name);
    expect(display.requestSections[0]).toMatchObject({ content: JSON.stringify(args, null, 2), language: 'json' });
  });
  it.each([
    ['write', { state: 'closed', surface: 'analyst', propagation: { partial: true, ok: false, error: 'p'.repeat(1000) } }, ['Failed', 'Record accepted', 'Partial propagation']],
    ['edit', { code: 'record_open_conflict', reason: 'r'.repeat(1000), restart_required: true }, ['Failed', 'Refused', 'Restart required']],
    ['write', { written: true, outcome_unknown: true }, ['Effects uncertain', 'Applied']],
    ['restart_server', { restart: 'confirmation_required', confirmationMessage: 'c'.repeat(1000) }, ['Failed', 'Confirmation required']],
    ['stop_project', { status: 'stopped', contained: false }, ['Failed', 'Stopped', 'Not contained']],
    ['start_project', { started: true, stopped: true, status: 'stopped' }, ['Failed', 'Project started', 'Subsequently stopped']],
    ['queue_notification', { queued: true, interruption: { status: 'pending_tool_settlement', reason: 'r'.repeat(1000) } }, ['Failed', 'Queued', 'Delivery not reported', 'pending_tool_settlement']],
    ['grep', { content_truncated: true, matches: { items: [{ content_hex: '7b' }], next: { item_index: 1 } } }, ['Failed', 'Line content truncated', 'Partial coverage', 'Partial JSON items']],
    ['webfetch', { head_complete: false, fetch_truncated: true }, ['Failed', 'Text head incomplete', 'Fetch truncated']],
  ] as const)('keeps parsed %s qualifications outside one bounded error excerpt', (tool, data, qualifications) => {
    const error = `Faithful envelope reason ${'very long prose '.repeat(200)}FINAL-ERROR`;
    const raw = JSON.stringify({ success: false, error, data: { ...data, ...(tool === 'edit' ? { code: 'LONG-CODE-'.repeat(100) } : {}), reason: 'LONG-REASON-'.repeat(100) } });
    const r = result(tool, {}, { content: raw });
    const display = buildToolDisplay({ entry: call(tool, { path: 'selected.txt' }), mate: r });
    const view = presentToolResult(raw, { tool });
    const status = inlinePartsText(display.status);
    for (const qualification of qualifications) expect(view.outcome).toContain(qualification);
    expect(status.startsWith(view.outcome)).toBe(true);
    expect(inlinePartsText(view.headline).length).toBeLessThanOrEqual(56);
    expect(status.slice(view.outcome.length + 3).length).toBeLessThanOrEqual(56);
    expect(status).toContain('Faithful envelope reason');
    expect(display.resultSections.find(section => section.title === ('outcome_unknown' in data && data.outcome_unknown ? 'Uncertainty' : 'Error'))?.content).toBe(error);
    expect(JSON.stringify(display.resultSections)).toContain('LONG-REASON-');
    expect(r.content).toBe(raw);
  });
  it.each([
    ['read', { path: 'work:///tmp/review.txt' }, 'work:///tmp/review.txt', 'Open file'],
    ['write', { path: 'record:///brief.md?card=card-a', content: 'supplied' }, 'record:///brief.md?card=card-a', 'Open file'],
    ['edit_card', { card_id: 'card-a' }, 'card-a', 'Open card'],
  ] as const)('keeps linked %s targets readable in the primary with a separate concise action', (tool, args, target, linkLabel) => {
    const display = buildToolDisplay({ entry: call(tool, args), mate: null });
    expect(inlinePartsText(display.target)).toBe(target);
    expect(display.target.every(part => part.kind === 'text')).toBe(true);
    expect(inlinePartsText(display.links)).toBe(linkLabel);
    expect(display.links).toHaveLength(1);
    expect(inlinePartsText(display.links)).not.toContain(target);
  });
  it.each([
    ['write', { path: 'unique-file-Z.txt', content: 'full supplied content' }, { target: 'unique-file-Z.txt', written: true, bytes: 21 }, 'unique-file-Z.txt'],
    ['edit', { path: 'unique-edit-Z.ts', old_string: 'old', new_string: 'new' }, { path: 'unique-edit-Z.ts', edited: true, replacements: 2 }, 'unique-edit-Z.ts'],
    ['write', { path: 'record:///status.md?card=card-a', content: 'full record' }, { card_id: 'card-a', name: 'status.md', current_url: 'record:///status.md?card=card-a', accepted_version_url: 'record:///status.md?card=card-a&v=4', state: 'open', surface: 'card_agent', revision: 7, head_id: '33333333-3333-4333-8333-333333333333', written: true, bytes: 11 }, 'status.md'],
    ['webfetch', { url: 'https://example.test/unique-fetch-Z' }, { redacted_url: 'https://example.test/unique-fetch-Z', metadata_only: true, status: 200, headers: {} }, 'unique-fetch-Z'],
    ['reconfigure', { action: 'set_server_setting', key: 'port', value: 8080 }, { action: 'set_server_setting', key: 'port', value: 8080, applied: true, requires_restart: true }, 'set_server_setting'],
  ] as const)('does not repeat %s targets in the outcome while preserving complete semantic evidence', (tool, args, data, target) => {
    const display = buildToolDisplay({ entry: call(tool, args), mate: result(tool, data) });
    expect(inlinePartsText(display.target)).toContain(target);
    expect(inlinePartsText(display.status)).not.toContain(target);
    expect(JSON.stringify(display.requestSections)).toContain(target);
    expect(JSON.stringify(display.resultSections)).toContain(target);
  });
  it.each([
    ['read', { path: 'file.md', position: 5 }, { total_bytes: 100, content: { content: 'FULL-SLICE-Z', utf8_bytes: 12, offset_bytes: 5, next_offset_bytes: 17 } }, ['position', 'FULL-SLICE-Z', 'next offset bytes']],
    ['grep', { path: 'src', pattern: 'needle', include: '*.ts' }, { matches: { items: [{ path: 'src/a.ts', line: 3, preview: 'FULL-MATCH-Z' }], total: 1, returned: 1, next: null }, content_truncated: true }, ['include', 'FULL-MATCH-Z', 'Line content truncated']],
    ['apply_patch', { patch: 'FULL-PATCH-Z' }, { applied: true, changed_files: ['src/a.ts', 'src/b.ts'] }, ['FULL-PATCH-Z', 'src/a.ts', 'src/b.ts']],
    ['create_card', { title: 'Requested card', type: 'task', parent: 'project', bootstrap_content: 'FULL-BOOTSTRAP-Z' }, { card: { id: 'card-a', title: 'Recorded card', status: 'BACKLOG' } }, ['FULL-BOOTSTRAP-Z', 'Recorded card', 'BACKLOG']],
    ['queue_notification', { card_id: 'card-a', body: 'FULL-NOTICE-Z', urgency: 'urgent' }, { queued: true, card_id: 'card-a', body: 'FULL-NOTICE-Z', interruption: { status: 'suppressed', reason: 'owner unavailable' } }, ['FULL-NOTICE-Z', 'owner unavailable', 'suppressed']],
    ['get_card_version', { card_id: 'card-a', version: 4, section: 'brief' }, { card_id: 'card-a', version: 4, content: { content: 'FULL-HISTORY-Z', utf8_bytes: 14, offset_bytes: 0, next_offset_bytes: 14 } }, ['Immutable history version', 'FULL-HISTORY-Z']],
    ['skill', { name: 'review' }, { skill_name: 'review', skill_content: 'FULL-INSTRUCTIONS-Z' }, ['FULL-INSTRUCTIONS-Z']],
    ['mcp_tool_call', { serverName: 'server', toolName: 'probe', args: { safe: 'FULL-ARGS-Z' } }, { result: { structuredContent: { opaque: 'FULL-OPAQUE-Z' } } }, ['FULL-ARGS-Z', 'FULL-OPAQUE-Z', 'Effects opaque']],
  ] as const)('provides useful %s selection/content/effect detail without requiring RAW', (tool, args, data, facts) => {
    const display = buildToolDisplay({ entry: call(tool, args), mate: result(tool, data) });
    const detail = JSON.stringify([...display.requestSections, ...display.resultSections]) + inlinePartsText(display.status);
    for (const fact of facts) expect(detail).toContain(fact);
    expect(display.requestSections.length).toBeGreaterThan(0);
    expect(display.resultSections.length).toBeGreaterThan(0);
  });
  it.each([
    ['queue_notification', { card_id: 'card-a', body: 'full notice' }, { queued: true, card_id: 'card-a', body: 'full notice' }, 'Delivery not reported'],
    ['write', { path: 'record:///brief.md?card=card-a', content: 'full content' }, { name: 'brief.md', state: 'open', surface: 'card_agent' }, 'Draft updated'],
    ['write', { path: 'record:///brief.md?card=card-a', content: 'full content' }, { name: 'brief.md', state: 'closed', surface: 'analyst', propagation: { ok: false, partial: true, error: 'ancestor refused' } }, 'Partial propagation'],
    ['restart_server', {}, { restart: 'confirmation_required', confirmationMessage: 'RESTART SERVER' }, 'Confirmation required'],
    ['start_project', {}, { started: false, stopped: false, status: 'running' }, 'Observed running'],
    ['read', { path: 'large.bin' }, { metadata_only: true }, 'Metadata only'],
    ['edit', { path: 'code.ts', old_string: 'old', new_string: 'new' }, { edited: true, replacements: 2 }, 'Applied'],
    ['reconfigure', { action: 'set' }, { applied: false, requires_restart: true }, 'Requires restart'],
  ] as const)('keeps %s domain meaning and both independent details', (tool, args, data, meaning) => {
    const display = buildToolDisplay({ entry: call(tool, args), mate: result(tool, data) });
    expect(inlinePartsText(display.status)).toContain(meaning);
    expect(display.requestSections.length).toBeGreaterThan(0);
    expect(display.resultSections.length).toBeGreaterThan(0);
    expect(inlinePartsText(display.status)).not.toMatch(/Passed|Delivered|started: false/);
  });
});
