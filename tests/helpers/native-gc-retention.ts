import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { CardService } from '../../src/cards/card-service.js';
import { createResolvedConfigAuthority } from '../../src/config/index.js';
import { iterateAuthoredRecordVersions, readCurrentAuthoredRecord } from '../../src/persistence/authored-record-files.js';
import { iterateCanonicalLinkedCardHistoryTree, readPendingCardNotifications } from '../../src/persistence/card-files.js';
import { inspectCardExecutions } from '../../src/persistence/card-execution-log.js';
import { inspectConversationIndex, inspectConversationSegment } from '../../src/persistence/conversation-file.js';
import { cardExecutionFile, cardMailboxFile, cardConversationVersionIndexFile, globalAgentConversationVersionIndexFile, saivageWorkRoot } from '../../src/persistence/layout.js';
import { cardAgentSessionId, globalAgentSessionId, genericRecordDefinition, type ConversationSessionId, type RecordDefinition } from '../../src/schemas/index.js';
import { inventoryWorkGarbage } from '../../src/workspace/work-garbage-collector.js';
import { fixtureGit } from './public-native-project.js';

export const nativeGcBefore = new Date(2000).toISOString();
const recordName = 'gc-capture.md';
const generic = genericRecordDefinition(recordName);
const definition: RecordDefinition = { filename: recordName, format: generic.format, schema: generic.schema, bootstrap: false, declared: false };
interface NativeGcPair {
  historical: string; current: string; scratch: string; recent: string;
  historicalContent: string; currentContent: string; invocationId: string;
}
function workflows(root: string) {
  return createResolvedConfigAuthority({ path: join(root, '.saivage/saivage.yaml'), projectRoot: root, interpolationEnvironment: process.env }).loadEffective().workflows;
}

/** Public init has exited: these successful bootstrap processes have no live presentation owner. */
export function seedNativeGcPair(root: string): NativeGcPair {
  const execution = inspectCardExecutions(root, 'project');
  assert.equal(execution.tornSuffixLength, 0);
  const rows = execution.projection;
  const bootstrap = rows.find(row => row.kind === 'native_started' && row.step === 'commission' && row.binding.origin === 'bootstrap');
  assert(bootstrap);
  const invocation = rows.filter(row => row.invocation_id === bootstrap.invocation_id);
  assert(invocation.some(row => row.kind === 'native_finished' && row.outcome === 'commissioned' && row.disposition === 'returned'));
  const captures = invocation.flatMap(row => {
    if (row.kind !== 'native_process_started') return [];
    assert(invocation.some(finish => finish.kind === 'native_process_finished' && finish.process_id === row.process_id && (finish.status === 'exited' || finish.status === 'failed') && finish.disposition === 'returned' && finish.leader_exit !== null && finish.leader_exit.exit_code !== null && row.allowed_exit_codes.includes(finish.leader_exit.exit_code)));
    const capture = row.files.find(file => file.kind === 'capture');
    assert(capture);
    const path = resolve(root, capture.path);
    assert(existsSync(path));
    return [path];
  });
  const historical = captures[0];
  assert(historical);
  const current = captures.find(path => dirname(path) !== dirname(historical));
  assert(current, 'commission must have captures from two different settled process directories');
  const uri = (path: string) => `work:///${relative(saivageWorkRoot(root), path)}`;
  const cards = new CardService(root, workflows(root));
  cards.acceptRecord('project', recordName, uri(historical), { kind: 'agent', agent: 'analyst' });
  cards.acceptRecord('project', recordName, uri(current), { kind: 'agent', agent: 'analyst' });
  const scratch = join(saivageWorkRoot(root), 'cards/project/tmp/gc-unselected');
  const recent = join(saivageWorkRoot(root), 'cards/project/tmp/gc-recent');
  mkdirSync(dirname(scratch), { recursive: true });
  writeFileSync(scratch, 'disposable scratch'); writeFileSync(recent, 'recent sentinel');
  for (const path of [historical, current, scratch]) utimesSync(path, 1, 1);
  utimesSync(recent, 3, 3);
  const pair = { historical, current, scratch, recent, historicalContent: uri(historical), currentContent: uri(current), invocationId: bootstrap.invocation_id };
  verifyNativeGcPair(root, pair);
  return pair;
}

export function verifyNativeGcPair(root: string, pair: NativeGcPair) {
  const cards = new CardService(root, workflows(root)), card = cards.read('project')!;
  const current = readCurrentAuthoredRecord(root, card, definition)!;
  assert.equal(current.accepted!.content, pair.currentContent);
  assert.equal(current.baseline, null); assert.equal(current.draft, null);
  const history = [...iterateAuthoredRecordVersions(root, card, definition)];
  assert.equal(history.length, 2);
  assert.deepEqual(history.map(version => version.accepted.content), [pair.currentContent, pair.historicalContent]);
}

/** Production inventory, not a synthetic list: only the named three files are old. */
export async function verifyNativeGcAges(root: string, pair: NativeGcPair) {
  const inventory = await inventoryWorkGarbage(root, new AbortController().signal);
  const old = inventory.candidates.filter(candidate => candidate.mtimeMs < 2000);
  assert.deepEqual(old.map(candidate => candidate.path).sort(), [pair.historical, pair.current, pair.scratch].map(path => relative(saivageWorkRoot(root), path)).sort());
  assert(old.every(candidate => candidate.mtimeMs === 1000));
  assert.equal(inventory.candidates.find(candidate => candidate.path === relative(saivageWorkRoot(root), pair.recent))!.mtimeMs, 3000);
  assert(inventory.candidates.every(candidate => candidate.mtimeMs === 1000 || candidate.mtimeMs > 2000));
  return readFileSync(pair.historical).length + readFileSync(pair.scratch).length;
}

/** Hash only exact linked/indexed selections through strict owners, never persistence siblings. */
export function nativeGcSnapshot(root: string, pair: NativeGcPair) {
  verifyNativeGcPair(root, pair);
  const selected = new Map<string, string | null>();
  const onBytes = (path: string, bytes: Buffer | null) => selected.set(relative(root, path), bytes === null ? null : createHash('sha256').update(bytes).digest('hex'));
  const read = (path: string) => onBytes(path, existsSync(path) ? readFileSync(path) : null);
  const instrumentation = { onRead: () => {}, onBytes };
  const compiled = workflows(root), sessions = new Set<ConversationSessionId>([globalAgentSessionId(compiled.analyst.name)]);
  const refs = new Set(['refs/heads/main']);
  for (const selection of iterateCanonicalLinkedCardHistoryTree(root, instrumentation)) {
    if (selection.tombstone) continue;
    const card = selection.current, workflow = compiled.cardTypes.get(card.type)!;
    readPendingCardNotifications(root, card.id);
    for (const id of card.pending_notifications) read(cardMailboxFile(root, card.id, id));
    const definitions: RecordDefinition[] = [...workflow.records.values()].map(record => ({ filename: record.name, format: record.format, schema: record.schema, bootstrap: record.bootstrap, declared: true }));
    if (card.id === 'project') definitions.push(definition);
    for (const record of definitions) {
      readCurrentAuthoredRecord(root, card, record, instrumentation);
      for (const _version of iterateAuthoredRecordVersions(root, card, record, instrumentation)) { /* consume complete selected predecessors */ }
    }
    const execution = inspectCardExecutions(root, card.id);
    assert.equal(execution.tornSuffixLength, 0); read(cardExecutionFile(root, card.id));
    const unfinished = new Set<string>();
    for (const row of execution.projection) {
      if (row.kind === 'native_started' || row.kind === 'invocation_started') unfinished.add(row.invocation_id);
      if (row.kind === 'native_finished' || row.kind === 'invocation_finished') unfinished.delete(row.invocation_id);
    }
    for (const row of execution.projection) if (unfinished.has(row.invocation_id)) {
      if (row.kind === 'native_started' || row.kind === 'invocation_started') for (const path of row.artifact_paths) read(resolve(root, path));
      if (row.kind === 'native_process_started' || row.kind === 'process_started') for (const file of row.files) read(resolve(root, file.path));
    }
    for (const state of workflow.states.values()) if (state.kind === 'node' && state.execution.kind === 'agent' && state.execution.agent.session === 'card') sessions.add(cardAgentSessionId(state.execution.agent.name, card.id));
    if (card.git) {
      refs.add(card.git.branch_ref); refs.add(card.git.parent.branch_ref);
      if (card.git.correction) {
        refs.add(card.git.correction.retained_original_ref);
        if (card.git.correction.preserved_source) refs.add(card.git.correction.preserved_source.ref);
      }
    }
  }
  const oversight = globalAgentConversationVersionIndexFile(root, compiled.oversight.name);
  read(oversight);
  if (existsSync(oversight)) sessions.add(globalAgentSessionId(compiled.oversight.name));
  for (const session of sessions) {
    const [, agent, card] = session.split(':');
    const path = card === 'global' ? globalAgentConversationVersionIndexFile(root, agent!) : cardConversationVersionIndexFile(root, card!, agent!);
    const bytes = readFileSync(path); onBytes(path, bytes);
    const index = inspectConversationIndex(root, session, bytes);
    for (const entry of index.versions) {
      const segment = inspectConversationSegment(root, session, index, entry.version, instrumentation);
      assert(segment); assert.equal(segment.tornSuffixLength, 0);
    }
  }
  for (const path of [join(root, 'source.txt'), join(root, '.git/HEAD'), join(root, '.git/index'), pair.current, pair.recent]) {
    assert(existsSync(path)); read(path);
  }
  return { files: [...selected].sort(([a], [b]) => a.localeCompare(b)), refs: [...refs].sort().map(ref => [ref, fixtureGit(root, 'rev-parse', ref)]) };
}
