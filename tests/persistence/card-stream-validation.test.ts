import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../src/cards/card-service.js';
import { cardStreamRowSchema, validateCardStream, type CardStreamRow } from '../../src/persistence/canonical-card-artifacts.js';
import { readCardArtifacts } from '../../src/persistence/card-files.js';
import { parseGrowingFile } from '../../src/persistence/growing-file.js';
import { cardStreamFile } from '../../src/persistence/layout.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function input(type: 'goal' | 'code' = 'code') {
  return { type, parent: 'project', title: 'Stream contract', brief: 'Validate the card stream.', tags: [], priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, depends_on: [], related: [] };
}

function updatedRows(initialType: 'goal' | 'code'): { id: string; rows: CardStreamRow[] } {
  const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
  roots.push(root);
  initProjectTree(root);
  const cards = new CardService(root);
  const card = cards.create(input(initialType));
  cards.update(card.id, { title: 'Still the same type' });
  return { id: card.id, rows: structuredClone(readCardArtifacts(root, card.id).artifacts) };
}

describe('two-kind card stream validation', () => {
  it('accepts real stopped-transition rows with their exact v2 lifecycle-only reasons', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const card = cards.create(input());
    cards.setStatus(card.id, 'running');
    cards.stopRunningForRecovery(card.id);
    cards.activateStopped(card.id);

    const rows = readCardArtifacts(root, card.id).artifacts;
    expect(validateCardStream(rows, cardStreamFile(root, card.id), card.id).current.card.lifecycle.status).toBe('running');
    expect(rows.filter((row) => row.kind === 'card-version').map((row) => row.history?.change_reason)).toEqual([
      undefined,
      'status -> running',
      'recovery stopped lifecycle',
      'STOPPED activation',
    ]);
  });

  it('rejects v1 and removed card snapshot fields', () => {
    const { rows } = updatedRows('code');
    expect(cardStreamRowSchema.safeParse({ ...rows[0], format_version: 1 }).success).toBe(false);
    const initial = rows[0];
    if (initial?.kind !== 'card-version') throw new Error('expected card version');
    for (const field of ['status', 'parent', 'depth', 'allowedActions']) {
      expect(cardStreamRowSchema.safeParse({ ...initial, card: { ...initial.card, [field]: null } }).success).toBe(false);
    }
  });

  it.each(['intent', 'write_intent', 'reset'])('keeps the strict v2 row schema free of %s', (field) => {
    const { rows } = updatedRows('code');
    const invalid = structuredClone(rows[1]!);
    (invalid as unknown as Record<string, unknown>)[field] = 'forbidden';
    expect(() => cardStreamRowSchema.parse(invalid)).toThrow();
  });

  it('replays ordinary running terminal outcomes without a persisted write intent', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const done = cards.create(input());
    const failed = cards.create(input());
    const blocked = cards.create(input());
    for (const card of [done, failed, blocked]) cards.setStatus(card.id, 'running');
    cards.commitTerminalLifecycle(done.id, { lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-07-19T00:00:00.000Z' } });
    cards.commitTerminalLifecycle(failed.id, { lifecycle: { status: 'failed', result: { kind: 'failed', summary: 'failed' }, error: 'failed', completed_at: '2026-07-19T00:00:00.000Z' } });
    cards.commitTerminalLifecycle(blocked.id, { lifecycle: { status: 'blocked', result: { kind: 'blocked', summary: 'blocked' }, error: 'blocked', completed_at: null } });

    for (const card of [done, failed, blocked]) {
      const rows = readCardArtifacts(root, card.id).artifacts;
      expect(validateCardStream(rows, cardStreamFile(root, card.id), card.id).current.card.lifecycle.status).toBe(cards.read(card.id)?.lifecycle.status);
      expect(JSON.stringify(rows)).not.toMatch(/write_intent|"intent"|"reset"/);
    }
  });

  it('accepts only contiguous card versions before an optional terminal tombstone', () => {
    const { id, rows } = updatedRows('code');
    expect(rows.map((row) => row.kind)).toEqual(['card-version', 'card-version']);
    expect(validateCardStream(rows, '/canonical/card.jsonl', id).current.version).toBe(2);

    const noncontiguous = structuredClone(rows);
    const later = noncontiguous[1]!;
    if (later.kind !== 'card-version') throw new Error('Expected a card version.');
    later.version = 3;
    later.card.version_seq = 3;
    expect(() => validateCardStream(noncontiguous, '/canonical/card.jsonl', id)).toThrow(/does not match its stream/);
  });

  it.each<{ initialType: 'goal' | 'code'; changedType: 'goal' | 'code' }>([
    { initialType: 'goal', changedType: 'code' },
    { initialType: 'code', changedType: 'goal' },
  ])('rejects a later $initialType to $changedType type transition', ({ initialType, changedType }) => {
    const { id, rows } = updatedRows(initialType);
    const later = rows[1]!;
    if (later.kind !== 'card-version') throw new Error('Expected a card version.');
    later.card.type = changedType;
    expect(() => validateCardStream(rows, '/canonical/card.jsonl', id)).toThrow("mutates immutable field 'type'");
  });

  it('allows a child link to mutate only children, version, and update time', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
    roots.push(root);
    initProjectTree(root);
    new CardService(root).create(input());
    const rows = structuredClone(readCardArtifacts(root, 'project').artifacts);
    expect(rows.map((row) => row.kind)).toEqual(['card-version', 'card-version']);
    const link = rows[1]!;
    if (link.kind !== 'card-version') throw new Error('Expected a child-link card version.');
    expect(link.history?.kind).toBe('child_link');
    expect(validateCardStream(rows, '/canonical/card.jsonl', 'project').current.version).toBe(2);
    const replaced = structuredClone(rows);
    const replacedLink = replaced[1]!;
    if (replacedLink.kind !== 'card-version') throw new Error('Expected a child-link card version.');
    replacedLink.card.children = [replacedLink.card.children[0]!, 'card-z'];
    expect(() => validateCardStream(replaced, '/canonical/card.jsonl', 'project')).toThrow(/invalid children transition/);

    link.card.title = 'Forbidden during child link';
    expect(() => validateCardStream(rows, '/canonical/card.jsonl', 'project')).toThrow(/child-link row mutates 'title'/);
  });

  it('accepts only a real children-only same-membership permutation, including retained-link movement', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const first = cards.create(input());
    const retained = cards.create(input());
    const second = cards.create(input());
    cards.deleteSubtrees([retained.id], { actor: 'analyst', surface: 'runtime' }, () => true);
    cards.reorderChildren('project', [second.id, first.id], { actor: 'analyst', surface: 'runtime', reason: 'test reorder' });
    const rows = structuredClone(readCardArtifacts(root, 'project').artifacts);
    const reorder = rows.at(-1)!;
    if (reorder.kind !== 'card-version' || !reorder.history) throw new Error('Expected a reorder card version.');
    expect(reorder.card.children).toEqual([second.id, first.id, retained.id]);
    expect(reorder.history).toMatchObject({ kind: 'mutate', changed_fields: ['children'] });
    expect(validateCardStream(rows, '/canonical/card.jsonl', 'project').current.card.children).toEqual([second.id, first.id, retained.id]);

    const identity = structuredClone(rows);
    const identityRow = identity.at(-1)!;
    if (identityRow.kind !== 'card-version' || !identityRow.history) throw new Error('Expected a reorder card version.');
    identityRow.card.children = [...identityRow.history.snapshot.children];
    expect(() => validateCardStream(identity, '/canonical/card.jsonl', 'project')).toThrow(/invalid children transition/);

    const changedMembership = structuredClone(rows);
    const changedRow = changedMembership.at(-1)!;
    if (changedRow.kind !== 'card-version') throw new Error('Expected a reorder card version.');
    changedRow.card.children[0] = 'card-z';
    expect(() => validateCardStream(changedMembership, '/canonical/card.jsonl', 'project')).toThrow(/invalid children transition/);

    const duplicate = structuredClone(rows);
    const duplicateRow = duplicate.at(-1)!;
    if (duplicateRow.kind !== 'card-version') throw new Error('Expected a reorder card version.');
    duplicateRow.card.children[1] = duplicateRow.card.children[0]!;
    expect(() => validateCardStream(duplicate, '/canonical/card.jsonl', 'project')).toThrow();

    for (const nextChildren of [
      [...reorder.card.children, 'card-z'],
      reorder.card.children.slice(1),
      ['card-z', ...reorder.card.children.slice(1)],
    ]) {
      const invalid = structuredClone(rows);
      const invalidRow = invalid.at(-1)!;
      if (invalidRow.kind !== 'card-version') throw new Error('Expected a reorder card version.');
      invalidRow.card.children = nextChildren;
      expect(() => validateCardStream(invalid, '/canonical/card.jsonl', 'project')).toThrow(/invalid children transition/);
    }

    const wrongKind = structuredClone(rows);
    const wrongKindRow = wrongKind.at(-1)!;
    if (wrongKindRow.kind !== 'card-version' || !wrongKindRow.history) throw new Error('Expected a reorder card version.');
    wrongKindRow.history.kind = 'update';
    expect(() => validateCardStream(wrongKind, '/canonical/card.jsonl', 'project')).toThrow(/invalid children transition/);

    const wrongFields = structuredClone(rows);
    const wrongFieldsRow = wrongFields.at(-1)!;
    if (wrongFieldsRow.kind !== 'card-version' || !wrongFieldsRow.history) throw new Error('Expected a reorder card version.');
    wrongFieldsRow.history.changed_fields = ['children', 'title'];
    expect(() => validateCardStream(wrongFields, '/canonical/card.jsonl', 'project')).toThrow(/invalid children transition/);

    const piggyback = structuredClone(rows);
    const piggybackRow = piggyback.at(-1)!;
    if (piggybackRow.kind !== 'card-version') throw new Error('Expected a reorder card version.');
    piggybackRow.card.title = 'piggybacked';
    expect(() => validateCardStream(piggyback, '/canonical/card.jsonl', 'project')).toThrow(/children-reorder row mutates 'title'/);
  });

  it('requires an exact type-preserving tombstone and rejects every later row', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const card = cards.create(input());
    cards.deleteSubtrees([card.id], { actor: 'analyst', surface: 'runtime', reason: 'delete' }, () => true);
    const path = cardStreamFile(root, card.id);
    const rows = parseGrowingFile(path, readFileSync(path, 'utf8'), cardStreamRowSchema);
    const validated = validateCardStream(rows, path, card.id);
    expect(rows.map((row) => row.kind)).toEqual(['card-version', 'card-tombstone']);
    expect(validated.tombstone?.final_card.type).toBe('code');

    const changedHistoryCardId = structuredClone(rows);
    const cardIdTombstone = changedHistoryCardId.at(-1)!;
    if (cardIdTombstone.kind !== 'card-tombstone') throw new Error('Expected a terminal tombstone.');
    cardIdTombstone.deletion_history.card_id = 'card-z';
    expect(() => validateCardStream(changedHistoryCardId, path, card.id)).toThrow(/invalid tombstone/);

    const changedHistoryTime = structuredClone(rows);
    const timeTombstone = changedHistoryTime.at(-1)!;
    if (timeTombstone.kind !== 'card-tombstone') throw new Error('Expected a terminal tombstone.');
    timeTombstone.deletion_history.changed_at = '2000-01-01T00:00:00.000Z';
    expect(() => validateCardStream(changedHistoryTime, path, card.id)).toThrow(/invalid tombstone/);

    const changedHistoryVersion = structuredClone(rows);
    const versionTombstone = changedHistoryVersion.at(-1)!;
    if (versionTombstone.kind !== 'card-tombstone') throw new Error('Expected a terminal tombstone.');
    versionTombstone.deletion_history.version_seq = versionTombstone.final_card.version_seq + 1;
    expect(() => validateCardStream(changedHistoryVersion, path, card.id)).toThrow(/invalid tombstone/);

    const changedType = structuredClone(rows);
    const tombstone = changedType.at(-1)!;
    if (tombstone.kind !== 'card-tombstone') throw new Error('Expected a terminal tombstone.');
    tombstone.final_card.type = 'goal';
    expect(() => validateCardStream(changedType, path, card.id)).toThrow(/invalid tombstone/);
    expect(() => validateCardStream([...rows, rows[0]!], path, card.id)).toThrow(/invalid tombstone position/);
  });
});
