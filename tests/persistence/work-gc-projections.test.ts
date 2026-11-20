import { afterEach, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initProjectTree, TEST_WORKFLOWS, CardService } from '../helpers/canonical-project.js';
import { compactWorkGcCard } from '../helpers/work-gc-compaction.js';
import {
  readWorkGcCard, readWorkGcRecord, readWorkGcConversation,
  readWorkGcExecutionPaths, readWorkGcNotification,
} from '../../src/persistence/index.js';
import { readCurrentConversationSegment, inspectConversationIndex } from '../../src/persistence/conversation-file.js';
import { cardHeadFile, cardHistoryFile, cardExecutionFile, cardRecordHeadFile, cardConversationVersionIndexFile, cardConversationVersionFile, cardMailboxFile } from '../../src/persistence/layout.js';
import { genericRecordDefinition } from '../../src/schemas/index.js';
import { rowWorkReferences } from '../../src/persistence/work-gc-protection.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gc-projections-'));
  roots.push(root); initProjectTree(root); return root;
}
it('projects a current card without validating change, lifecycle or predecessor', () => {
  const root = fixture(), head = JSON.parse(readFileSync(cardHeadFile(root, 'project'), 'utf8'));
  const path = cardHistoryFile(root, 'project', head.ordinary.entry_id);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(value, { predecessor: 'not a reference', change: 12 });
  Object.assign(value.card, { git: 42, status: {}, dependencies: 'invalid' });
  writeFileSync(path, JSON.stringify(value));
  const parse = jest.spyOn(JSON, 'parse');
  expect(readWorkGcCard(root, 'project')?.id).toBe('project');
  expect(parse).toHaveBeenCalledTimes(2);
  parse.mockRestore();
  expect(() => new CardService(root).read('project')).toThrow();
  value.card.child_membership = ['project'];
  writeFileSync(path, JSON.stringify(value));
  expect(() => readWorkGcCard(root, 'project')).toThrow();
});
it('decodes only the selected current conversation entry and payloads, without reconstructing policy or source joins', () => {
  const root = fixture(); compactWorkGcCard(root, TEST_WORKFLOWS);
  const segment = readCurrentConversationSegment(root, 'agent:planner:project')!;
  const indexPath = cardConversationVersionIndexFile(root, 'project', 'planner');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.versions[0] = false;
  index.versions.at(-1).genesis = false;
  writeFileSync(indexPath, JSON.stringify(index) + '\n');
  const path = cardConversationVersionFile(root, 'project', 'planner', segment.entry.filename);
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(envelope.rows[0], { source: false, continuation: false });
  envelope.rows[0].compaction.requiredModelFacts = false;
  envelope.rows[0].compaction.protectedPrompts = [
    { sourceVersion: false, sourceIndex: false, message: { content: 'protected.txt', context_policy: false } },
  ];
  writeFileSync(path, JSON.stringify(envelope) + '\n');
  const parse = jest.spyOn(JSON, 'parse');
  const result = readWorkGcConversation(root, 'agent:planner:project');
  expect([...result.references]).toEqual(['Synthetic GC boundary.', 'protected.txt'].map(value => ({ kind: 'content', value })));
  expect(result.horizon).toBe(Date.parse('2026-10-24T00:01:00Z'));
  expect(parse).toHaveBeenCalledTimes(2);
  parse.mockRestore();
  expect(() => inspectConversationIndex(root, 'agent:planner:project', readFileSync(indexPath))).toThrow();
  envelope.rows[0].timestamp = 'not a timestamp';
  writeFileSync(path, JSON.stringify(envelope) + '\n');
  expect(() => readWorkGcConversation(root, 'agent:planner:project')).toThrow();
});
it.each(['torn', 'envelope', 'row', 'association'] as const)('refuses required execution %s without truncating', kind => {
  const root = fixture(), path = cardExecutionFile(root, 'project');
  const row = { kind: kind === 'association' ? 'process_started' : 'unknown',
    card_id: 'project', invocation_id: randomUUID(), process_id: 'p', files: [] };
  const bytes = kind === 'torn' ? '{"version":3' : JSON.stringify({
    version: kind === 'envelope' ? 999 : 3, type: 'card-execution', rows: [row],
  }) + '\n';
  writeFileSync(path, bytes);
  expect(() => readWorkGcExecutionPaths(root, 'project')).toThrow();
  expect(readFileSync(path, 'utf8')).toBe(bytes);
});
it('projects record content without hash, schema or draft grammar', () => {
  const root = fixture(), definition = { ...genericRecordDefinition('extra.md'), filename: 'extra.md', declared: false };
  const path = cardRecordHeadFile(root, 'project', definition);
  mkdirSync(join(path, '..'), { recursive: true });
  const value = { format_version: 3, kind: 'record-head', card_id: 'project',
    record_name: 'extra.md', baseline: { content: 'keep.txt', content_sha256: false },
    draft: null, accepted: null, schema: 17 };
  writeFileSync(path, JSON.stringify(value));
  expect([...readWorkGcRecord(root, 'project', definition)]).toEqual(['keep.txt']);
  value.baseline.content = 42 as never;
  writeFileSync(path, JSON.stringify(value));
  expect(() => [...readWorkGcRecord(root, 'project', definition)]).toThrow();
});
it('projects the exact selected notification body without auditing notification metadata', () => {
  const root = fixture(), id = randomUUID();
  new CardService(root).enqueueNotification('project', {
    id, content: 'selected-notification.txt', created_at: '2026-10-24T00:00:00.000Z',
  });
  const path = cardMailboxFile(root, 'project', id);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  value.notification.created_at = false;
  value.notification.source = { unused: true };
  writeFileSync(path, JSON.stringify(value));
  expect(readWorkGcNotification(root, 'project', id)).toBe('selected-notification.txt');
  value.notification.content = false;
  writeFileSync(path, JSON.stringify(value));
  expect(() => readWorkGcNotification(root, 'project', id)).toThrow();
  value.notification.content = 'selected-notification.txt';
  value.notification.id = randomUUID();
  writeFileSync(path, JSON.stringify(value));
  expect(() => readWorkGcNotification(root, 'project', id)).toThrow();
});
it('distinguishes established empty and required absent conversations', () => {
  const root = fixture();
  expect(readWorkGcConversation(root, 'agent:planner:project')).toEqual({ horizon: null, references: [] });
  expect(() => readWorkGcConversation(root, 'agent:absent:project')).toThrow();
  expect(readWorkGcConversation(root, 'agent:absent:project', true).horizon).toBeNull();
});
it('folds finished executions before decoding irrelevant artifacts and native facts', () => {
  const root = fixture(), invocation_id = randomUUID();
  const path = cardExecutionFile(root, 'project');
  const rows = [
    { kind: 'native_started', invocation_id, card_id: 'project', artifact_paths: false, binding: false },
    { kind: 'native_finished', invocation_id, card_id: 'project', facts: false },
  ];
  writeFileSync(path, JSON.stringify({ version: 3, type: 'card-execution', rows }) + '\n');
  expect(readWorkGcExecutionPaths(root, 'project')).toEqual([]);
  rows.pop();
  writeFileSync(path, JSON.stringify({ version: 3, type: 'card-execution', rows }) + '\n');
  expect(() => readWorkGcExecutionPaths(root, 'project')).toThrow();
});
it('omits owned shell arguments but preserves arbitrary command fields and ignored rows', () => {
  const content = JSON.stringify({ tool_calls: [{ function: { name: 'run_command',
    arguments: JSON.stringify({ command: 'shell-only.txt', cwd: 'jobs/${name}' }) } }] });
  expect([...rowWorkReferences({ kind: 'tool_call', tool: 'run_command', content })]).toEqual([
    { kind: 'address', syntax: 'native', value: 'jobs/${name}' }, { kind: 'content', value: {} },
  ]);
  expect([...rowWorkReferences({ kind: 'provider_private', content: false })]).toEqual([]);
  expect([...rowWorkReferences({ kind: 'text', content: '{"command":"keep.txt"}' })])
    .toEqual([{ kind: 'content', value: '{"command":"keep.txt"}' }]);
  expect(() => [...rowWorkReferences({ kind: 'unknown' })]).toThrow();
});
it.each(['inline', 'running', 'incomplete'] as const)('keeps all reference-bearing process result fields (%s)', kind => {
  const data = {
    process_id: 'proc-0123456789ab', exit_code: 0, status: kind === 'running' ? 'running' : 'exited',
    stdout: 'stdout-reference.txt', stderr: 'stderr-reference.log',
    stdout_complete: kind !== 'incomplete', stderr_complete: true,
    stdout_url: 'work:///processes/proc-0123456789ab/stdout.log',
    stderr_url: 'work:///processes/proc-0123456789ab/stderr.log',
    stdout_bytes: 20, stderr_bytes: 20,
  };
  expect([...rowWorkReferences({ kind: 'tool_result', tool: 'run_command',
    content: JSON.stringify({ success: true, data }) })]).toEqual([
    { kind: 'content', value: ['stdout-reference.txt', 'stderr-reference.log'] },
    ...(kind === 'inline' ? [] : [{ kind: 'address', syntax: 'locator', value: data.stdout_url }]),
    ...(kind === 'running' ? [{ kind: 'address', syntax: 'locator', value: data.stderr_url }] : []),
  ]);
});

it('projects owned call slots just once and leaves independent bodies as content', () => {
  const project = (tool: string, args: unknown) => [...rowWorkReferences({ kind: 'tool_call', tool,
    content: JSON.stringify({ tool_calls: [{ function: { name: tool, arguments: JSON.stringify(args) } }] }),
  })];
  expect(project('grep', { path: 'tmp:///project/search', pattern: 'tmp:///project/do-not-lex.*', include: 'dir/*.md' }))
    .toEqual([{ kind: 'address', syntax: 'locator', value: 'tmp:///project/search' },
      { kind: 'content', value: 'dir/*.md' }, { kind: 'content', value: {} }]);
  expect(project('glob', { directory: 'record:///project', pattern: '*' }))
    .toEqual([{ kind: 'content', value: {} }]);
  expect(project('view_image', { path: 'reports/one?.png' }))
    .toEqual([{ kind: 'address', syntax: 'native', value: 'reports/one?.png' }, { kind: 'content', value: {} }]);
  expect(project('write', { path: 'reports/case${name}.ts', content: './independent.md' }))
    .toEqual([{ kind: 'address', syntax: 'native', value: 'reports/case${name}.ts' },
      { kind: 'content', value: { content: './independent.md' } }]);
});

it('projects both same-branch Webfetch copies without deriving requiredness from adjacent data', () => {
  const data = { saved_as: 'cardwork:///project/public/one%3F', write: {
    kind: 'workspace_file', data: { destination_kind: 'cardwork_url', target: 'cardwork:///project/public/two%2A' },
  }, redacted_url: 'https://fixture.invalid/?selected=tmp%3A%2F%2F%2Fproject%2Fevidence' };
  const result = (tool: string, origin: string, payload: unknown) =>
    [...rowWorkReferences({ kind: 'tool_result', tool, context_policy: { settlement_origin: origin },
      content: JSON.stringify(payload) })];
  const addresses = (required: boolean) => [data.saved_as, data.write.data.target].map(value => ({
    kind: 'address', syntax: 'cardwork', value, ...(required ? { required: true } : {}),
  }));
  expect(result('webfetch', 'executed', { success: true, data }).filter(ref => ref.kind === 'address'))
    .toEqual(addresses(true));
  expect(result('webfetch', 'unsupported', { success: true, data }).filter(ref => ref.kind === 'address'))
    .toEqual(addresses(false));
  expect(result('webfetch', 'executed', { success: false, error: './independent.md', data }))
    .toEqual([{ kind: 'content', value: './independent.md' }, { kind: 'content', value: data }]);
  expect(result('unrelated', 'executed', { success: true, data }))
    .toEqual([{ kind: 'content', value: data }]);
  expect(result('grep', 'executed', { success: true, data: { matches: { items: [
    { content_hex: 'aabb', offset_bytes: 3 }, { path: data.saved_as, preview: './keep.md' },
  ] } } }).filter(ref => ref.kind === 'address')).toEqual([{ kind: 'address', syntax: 'display', value: data.saved_as }]);
});
