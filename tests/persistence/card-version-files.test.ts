import { afterEach, describe, expect, it } from '@jest/globals';
import { closeSync, fstatSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { readStrictCanonicalGrowingFile } from '../../src/persistence/growing-file.js';
import { cardArtifactSchema, type CardArtifact } from '../../src/persistence/canonical-card-artifacts.js';
import { cardStreamFile } from '../../src/persistence/layout.js';
import { buildContentPolicyReadModel } from '../../src/application/read-models/content-policy-read-model.js';
import { CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY } from '../../src/schemas/index.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { readCanonicalLinkedCardHistoryTree, readCard,readCommittedCardArtifactCatalog } from '../../src/persistence/card-files.js';
import { runtimeFailure, workflowResult } from '../helpers/workflow-result.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';
import type { CanonicalReadInstrumentation } from '../../src/persistence/growing-file.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-')); roots.push(root); initProjectTree(root);
  return { root, cards: new CardService(root) };
}

function streamRows(root: string, cardId: string): CardArtifact[] { return readStrictCanonicalGrowingFile(cardStreamFile(root, cardId), cardArtifactSchema); }
function envelopeCount(root: string, cardId: string): number { return readFileSync(cardStreamFile(root, cardId), 'utf8').trimEnd().split('\n').length; }

function childInput(cardId: string, title: string) {
  return { type: 'code' as const, parent: cardId, title, bootstrap_content: 'brief', tags: [] as string[], priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, depends_on: [] as string[], related: [] as string[] };
}

describe('card exact stream', () => {
  it('publishes only row format 2 and rejects row format 1', () => {
    const { root } = fixture();
    const current = streamRows(root, 'project')[0]!;
    expect(current.format_version).toBe(2);
    expect(cardArtifactSchema.safeParse({ ...current, format_version: 1 }).success).toBe(false);
  });

  it.each(['blocked', 'failed'] as const)('retains strict changed-status then metadata-update history for a real %s correction', (status) => {
    const { root, cards } = fixture();
    const child = cards.create(childInput('project', 'before'));
    cards.setStatus(child.id, 'running');
    if (status === 'blocked') cards.commitActivationOutcome(child.id, { status, summary: 'blocked', result: workflowResult('BLOCKED', 'blocked') }, '2026-08-15T00:00:00.000Z');
    else cards.commitActivationOutcome(child.id, { status, summary: 'failed', result: runtimeFailure('failed') }, '2026-08-15T00:00:00.000Z');

    const beforeNoOp = readFileSync(cardStreamFile(root, child.id));
    expect(cards.editCard(child.id, { title: 'before' }, 'planner')).toMatchObject({ title: 'before', lifecycle: { status } });
    expect(readFileSync(cardStreamFile(root, child.id))).toEqual(beforeNoOp);

    cards.editCard(child.id, { title: 'after' }, 'planner');
    const rows = streamRows(root, child.id);
    const statusVersion = rows.at(-2)!.version;
    const updateVersion = rows.at(-1)!.version;
    expect(cards.readCardVersion(child.id, statusVersion)).toMatchObject({
      kind: 'found',
      value: {
        kind: 'card-version',
        card: { title: 'before', lifecycle: { status: 'changed' } },
        change: { kind: 'status', card_id: child.id, resulting_version: statusVersion, changed_by_actor: 'runtime', changed_by_surface: 'runtime', change_reason: 'status -> changed', changed_fields: ['lifecycle'] },
      },
    });
    expect(cards.readCardVersion(child.id, updateVersion)).toMatchObject({
      kind: 'found',
      value: {
        kind: 'card-version',
        card: { title: 'after', lifecycle: { status: 'changed' } },
        change: { kind: 'update', card_id: child.id, resulting_version: updateVersion, changed_by_actor: 'planner', changed_by_surface: 'runtime', change_reason: 'agent edit_card', changed_fields: ['title'] },
      },
    });
  });

  it('publishes one nonempty first envelope and exactly one envelope per mutation with contiguous row versions', () => {
    const { root, cards } = fixture();
    const child = cards.create(childInput('project', 'before'));
    const path = cardStreamFile(root, child.id);
    const initial = readFileSync(path);
    expect(initial.length).toBeGreaterThan(0);
    expect(initial.at(-1)).toBe(0x0a);
    expect(envelopeCount(root, child.id)).toBe(1);
    expect(streamRows(root, child.id).map(({ version, kind }) => ({ version, kind }))).toEqual([{ version: 1, kind: 'card-version' }]);

    cards.editCard(child.id, { title: 'after' }, 'planner');
    expect(envelopeCount(root, child.id)).toBe(2);
    const rows = streamRows(root, child.id);
    expect(rows.map(({ version }) => version)).toEqual([1, 2]);
    expect(readFileSync(path).subarray(0, initial.byteLength)).toEqual(initial);
    expect(readCommittedCardArtifactCatalog(root,child.id)).toMatchObject({ kind: 'found', value:{versions: [{ version: 1, artifact_kind: 'card-version' }, { version: 2, artifact_kind: 'card-version' }] }});
    expect(cards.read(child.id)?.title).toBe('after');
  });

  it('selects current, history, and diff from one strict complete fold', () => {
    const { root, cards } = fixture();
    const child = cards.create(childInput('project', 'before'));
    cards.editCard(child.id, { title: 'after' }, 'planner');
    const head = readStrictCanonicalGrowingFile(cardStreamFile(root, child.id), cardArtifactSchema).at(-1)!;
    expect(cards.readCardVersion(child.id, 1)).toMatchObject({ kind: 'found', value: { card: { title: 'before' } } });
    expect(cards.readCardVersion(child.id, 2)).toMatchObject({ kind: 'found', value: { card: { title: 'after' }, entry_id: head.entry_id } });
    expect(cards.readCardVersion(child.id, 3)).toEqual({ kind: 'version-not-found', version: 3 });
    const diff = cards.diffCardVersions(child.id, { fromVersion: 1, toVersion: 2 });
    expect(diff.kind).toBe('found');
    if (diff.kind === 'found') expect(diff.diff.find((entry) => entry.field === 'title')).toMatchObject({ before: 'before', after: 'after' });
  });

  it('publishes deletion as the terminal row, keeps the parent link, and keeps tombstoned history readable', () => {
    const { root, cards } = fixture();
    const child = cards.create(childInput('project', 'delete'));
    cards.deleteSubtrees([child.id], () => true, 'analyst');
    const rows = streamRows(root, child.id);
    expect(rows.map(({ kind }) => kind)).toEqual(['card-version', 'card-tombstone']);
    expect(cards.read(child.id)).toBeNull();
    expect(cards.read('project')?.child_membership).toContain(child.id);
    expect(cards.readCardVersion(child.id, 1)).toMatchObject({ kind: 'found', value: { kind: 'card-version' } });
    expect(cards.readCardVersion(child.id, 2)).toMatchObject({ kind: 'found', value: { kind: 'card-tombstone', prior_card_version: 1 } });
    expect(() => cards.editCard(child.id, { title: 'x' }, 'planner')).toThrow();
    const tree = readCanonicalLinkedCardHistoryTree(root);
    expect(tree.map(({ current }) => current.id)).toEqual(['project', child.id]);
    expect(tree.at(-1)!.tombstone).toMatchObject({ kind: 'card-tombstone' });
    for(const read of [(i:CanonicalReadInstrumentation)=>cards.listCardVersions(child.id,i),(i:CanonicalReadInstrumentation)=>cards.readCardVersion(child.id,2,i),(i:CanonicalReadInstrumentation)=>cards.readCommittedCardHead(child.id,i),(i:CanonicalReadInstrumentation)=>cards.diffCardVersions(child.id,{fromVersion:1,toVersion:'current'},i)]){const paths:string[]=[];read({onRead:(path)=>paths.push(path)});expect(paths).toEqual([cardStreamFile(root,'project'),cardStreamFile(root,child.id)]);}
  });

  it.each(['malformed', 'empty', 'empty-rows', 'unterminated'] as const)('fails fast on a %s card stream without fallback or mutation', (fault) => {
    const { root, cards } = fixture();
    const child = cards.create(childInput('project', 'before'));
    const path = cardStreamFile(root, child.id);
    if (fault === 'malformed') writeFileSync(path, '{complete malformed envelope}\n');
    else if (fault === 'empty') writeFileSync(path, '');
    else if (fault === 'empty-rows') writeFileSync(path, `${JSON.stringify({ version: 1, type: 'rows', rows: [] })}\n`);
    else writeFileSync(path, readFileSync(path).subarray(0, -1));
    expect(() => readCard(root, child.id)).toThrow();
    expect(() => cards.editCard(child.id, { title: 'after' }, 'planner')).toThrow();
    if (fault !== 'malformed') expect(() => streamRows(root, child.id)).toThrow();
    expect(() => cards.readCardVersion(child.id, 1)).toThrow();
  });

  it('propagates append outcome-unknown without reread, retry, or stream change', () => {
    const { root, cards } = fixture();
    const child = cards.create(childInput('project', 'before'));
    const cardsWithIo = new CardService(root, undefined, {
      open: openSync,
      stat: fstatSync,
      write: (() => { const failure = new Error('simulated append failure') as NodeJS.ErrnoException; failure.code = 'EIO'; throw failure; }) as typeof writeSync,
      fsync: fsyncSync,
      close: closeSync,
    } satisfies GrowingFileIo);
    const path = cardStreamFile(root, child.id);
    const before = readFileSync(path);
    expect(() => cardsWithIo.editCard(child.id, { title: 'after' }, 'planner')).toThrow(PublicationOutcomeUnknownError);
    expect(readFileSync(path)).toEqual(before);
  });

  it('derives content-policy history by folding row changes', () => {
    const { root, cards } = fixture();
    const child = cards.create(childInput('project', 'blocked'));
    cards.setStatus(child.id, 'running');
    const settledAt = '2026-08-12T00:00:00.000Z';
    cards.commitActivationOutcome(child.id, { status: 'blocked', summary: CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY, result: { kind: 'content-policy-refusal', summary: CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY, session_id: `agent:executor:${child.id}`, marker_id: 'marker', evidence_url: '/evidence' } }, settledAt);
    expect(buildContentPolicyReadModel(root, { onRead: () => undefined })).toMatchObject({ refusal_high_water: 1, latest: { card_id: child.id, blocked_at: settledAt } });
  });
});
