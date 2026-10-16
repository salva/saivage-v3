import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CardService, initProjectTree, TEST_WORKFLOWS } from '../../helpers/canonical-project.js';
import { testRecordDefinition } from '../../helpers/record-definitions.js';
import { AgentNodeExecution } from '../../../src/runtime/actors/agent-node-execution.js';
import { sha256Hex } from '../../../src/schemas/index.js';
import { recordHeadSchema, authoredRecordVersionArtifactSchema, isEligibleRecordContent } from '../../../src/persistence/canonical-record-artifacts.js';
import { inspectAuthoredRecordSelection } from '../../../src/persistence/authored-record-files.js';
import { cardRecordHeadFile, cardRecordPreviousHeadFile, cardAcceptedRecordFile } from '../../../src/persistence/layout.js';
import { observeRecordProjection } from '../../../src/persistence/record-observation.js';
import { NO_FRESHNESS_EFFECTS } from '../../../src/contracts/index.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/publication-outcome.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Methods = {
  prepareRecordRequirements(node: unknown): void;
  captureRecordHead(name: string): { headId: string; revision: number } | null;
  validateRecords(node: unknown, baseline: Map<string, unknown>): { candidates?: Map<string, any>; violations?: string[] };
  closeAcceptedRecords(node: unknown, candidates: Map<string, any>, written: Set<string>): unknown;
  discardWrittenRecords(written: Set<string>): void;
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'record-seed-')); roots.push(root); initProjectTree(root);
  const hint = jest.fn();
  const store = new CardService(root, { ...NO_FRESHNESS_EFFECTS, cardProjectionChanged: hint });
  const runner = new AgentNodeExecution({ cardId: 'project', store } as never, {} as never) as unknown as Methods;
  const read = () => { const result = store.readRecordCurrent('project', 'status.md'); if (result.kind !== 'found') throw new Error('missing card'); return result.value.projection; };
  return { root, store, runner, read, hint };
}
function node(mode: 'continue' | 'clean' = 'continue', gate: 'exists' | 'updated' = 'exists', content: string | null = 'seed\n', at = ['first_required_entry', 'clean_entry']) {
  return { agent: TEST_WORKFLOWS.cardTypes.get('project')!.states.get('node:plan')!.kind === 'node'
    ? (TEST_WORKFLOWS.cardTypes.get('project')!.states.get('node:plan') as any).agent : null,
    requirements: [{ mode, gate, definition: { name: 'status.md', initialization: content === null ? null : { content, at } } }] };
}
describe('required-entry scaffold lifecycle and authored eligibility', () => {
  it.each(['exists', 'updated'] as const)('captures %s baseline after setup, rejects seed/restore/whitespace, accepts actual work only', gate => {
    const f = fixture(); const selected = node('continue', gate);
    expect(f.read()).toBeNull();
    f.runner.prepareRecordRequirements(selected);
    const initial = f.read()!;
    const baseline = new Map([['status.md', f.runner.captureRecordHead('status.md')]]);
    expect(initial).toMatchObject({ revision: 1, accepted: null, draft: { content: 'seed\n', seed_sha256: sha256Hex('seed\n') } });
    expect(f.hint).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'record', record_name: 'status.md' }));
    expect(f.runner.validateRecords(selected, baseline).violations).toBeDefined();
    expect(() => f.store.closeRecord('project', 'status.md', 'planner')).toThrow(/unfilled scaffold/);
    expect(() => f.store.acceptRecord('project', 'status.md', 'operator edit', 'analyst')).toThrow(/open workflow draft/);
    f.store.editRecord('project', 'status.md', 'authored');
    f.store.editRecord('project', 'status.md', 'seed\n');
    expect(f.runner.validateRecords(selected, baseline).violations).toBeDefined();
    f.store.editRecord('project', 'status.md', ' \n');
    expect(f.runner.validateRecords(selected, baseline).violations).toBeDefined();
    expect(f.store.readRecordHistory('project', 'status.md')).toMatchObject({ value: { catalog: { versions: [] } } });
    f.store.editRecord('project', 'status.md', 'Current delivered assessment');
    const candidates = f.runner.validateRecords(selected, baseline).candidates!;
    expect(candidates.size).toBe(1);
    expect(f.runner.closeAcceptedRecords(selected, candidates, new Set(['status.md']))).toEqual([expect.objectContaining({ name: 'status.md', version: 6 })]);
    expect(f.read()!.accepted!.writer_agent).toBe('planner');
  });

  it.each(['accepted', 'draft', 'seed', 'discarded'] as const)('continue preserves present %s byte-for-byte through replacement/disable and a fresh owner', state => {
    const f = fixture();
    if (state === 'accepted') f.store.acceptRecord('project', 'status.md', 'before entry', 'analyst');
    else { f.runner.prepareRecordRequirements(node()); if (state === 'draft') f.store.editRecord('project', 'status.md', 'ongoing'); if (state === 'discarded') f.store.discardRecord('project', 'status.md'); }
    const path = cardRecordHeadFile(f.root, 'project', { filename: 'status.md' });
    const before = readFileSync(path);
    for (const content of ['replacement', null]) {
      const store = new CardService(f.root);
      const runner = new AgentNodeExecution({ cardId: 'project', store } as never, {} as never) as unknown as Methods;
      runner.prepareRecordRequirements(node('continue', 'exists', content));
      expect(readFileSync(path)).toEqual(before);
    }
  });

  it('clean opens once with both triggers, retains backing and uses a new choice only in a fresh cycle', () => {
    const f = fixture(); const open = jest.spyOn(f.store, 'openRecord');
    f.runner.prepareRecordRequirements(node('clean'));
    expect(open).toHaveBeenCalledTimes(1);
    f.store.editRecord('project', 'status.md', 'accepted assessment'); f.store.closeRecord('project', 'status.md', 'planner');
    f.runner.prepareRecordRequirements(node('clean', 'exists', 'replacement'));
    expect(f.read()).toMatchObject({ accepted: { content: 'accepted assessment' }, draft: { content: 'replacement', seed_sha256: sha256Hex('replacement') } });
    expect(isEligibleRecordContent(f.read()!)).toBe(false);
    f.store.editRecord('project', 'status.md', 'continuing changed body');
    expect(f.read()!.draft!.seed_sha256).toBe(sha256Hex('replacement'));
    f.runner.prepareRecordRequirements(node('continue', 'exists', 'other'));
    expect(f.read()!.draft!.content).toBe('continuing changed body');
    f.runner.prepareRecordRequirements(node('clean', 'exists', null));
    expect(f.read()).toMatchObject({ draft: { content: '', seed_sha256: null }, accepted: { content: 'accepted assessment' } });
  });

  it('first-only clean seeds absent heads but not present-empty ones; untemplated opening stays empty', () => {
    const f = fixture(); const first = node('clean', 'exists', 'first', ['first_required_entry']);
    f.runner.prepareRecordRequirements(first); expect(f.read()!.draft!.content).toBe('first');
    f.store.discardRecord('project', 'status.md'); f.runner.prepareRecordRequirements(first);
    expect(f.read()!.draft).toMatchObject({ content: '', seed_sha256: null });
    const free = f.store.openRecord('project', 'notes.md', null); expect(free.draft).toMatchObject({ content: '', seed_sha256: null });
  });

  it('retains auto-only drafts in nonaccepted cleanup and rejects free-draft seed acceptance', () => {
    const f = fixture(); f.runner.prepareRecordRequirements(node());
    const before = f.read(); f.runner.discardWrittenRecords(new Set()); expect(f.read()).toEqual(before);
    const freeNode = { ...node(), requirements: [] };
    expect(() => f.runner.closeAcceptedRecords(freeNode, new Map(), new Set(['status.md']))).toThrow(/non-empty open draft/);
    f.store.editRecord('project', 'status.md', 'genuine write');
    f.runner.discardWrittenRecords(new Set(['status.md'])); expect(f.read()!.draft).toBeNull();
  });

  it('keeps strict head2/artifact1 and repair selections distinct, including previous seeded provenance', () => {
    const f = fixture(); f.store.acceptRecord('project', 'status.md', 'supplied', 'analyst'); f.runner.prepareRecordRequirements(node('clean'));
    const def = testRecordDefinition('status.md');
    const current = readFileSync(cardRecordHeadFile(f.root, 'project', def));
    const head = recordHeadSchema.parse(JSON.parse(current.toString())); expect(head.format_version).toBe(2);
    expect(() => recordHeadSchema.parse({ ...head, format_version: 1 })).toThrow();
    const { seed_sha256: _seed, ...withoutSeed } = head.draft!;
    expect(() => recordHeadSchema.parse({ ...head, draft: withoutSeed })).toThrow();
    const artifact = JSON.parse(readFileSync(cardAcceptedRecordFile(f.root, 'project', head.accepted!.entry_id), 'utf8'));
    expect(authoredRecordVersionArtifactSchema.parse(artifact).format_version).toBe(1);
    expect(() => authoredRecordVersionArtifactSchema.parse({ ...artifact, format_version: 2 })).toThrow();
    expect(inspectAuthoredRecordSelection(f.root, 'project', def, current).projection.draft!.seed_sha256).toBe(sha256Hex('seed\n'));
    f.store.editRecord('project', 'status.md', 'changed');
    expect(inspectAuthoredRecordSelection(f.root, 'project', def, readFileSync(cardRecordPreviousHeadFile(f.root, 'project', def))).projection.draft!.content).toBe('seed\n');
    const observed = observeRecordProjection({ cardId: 'project', recordName: 'status.md', projection: f.read(), view: 'effective', selectionKind: 'current', exposure: { kind: 'metadata' } });
    expect(observed.selection).toMatchObject({ kind: 'draft', unfilled: false, accepted_backing: { kind: 'accepted', version: 1 } });
  });

  it('propagates publication uncertainty immediately without follow-up work', () => {
    const unknown = new PublicationOutcomeUnknownError(); const read = jest.fn(() => ({ kind: 'found', value: { projection: null } }));
    const open = jest.fn(() => { throw unknown; }); const discard = jest.fn();
    const runner = new AgentNodeExecution({ cardId: 'project', store: { readRecordCurrent: read, openRecord: open, discardRecord: discard } } as never, {} as never) as unknown as Methods;
    const selected = node(); selected.requirements.push(selected.requirements[0]!);
    expect(() => runner.prepareRecordRequirements(selected)).toThrow(unknown);
    expect(read).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledTimes(1); expect(discard).not.toHaveBeenCalled();
  });
});
