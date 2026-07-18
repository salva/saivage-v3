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
  return { type, parent: 'project', title: 'Stream contract', brief: 'Validate the card stream.', status: 'backlog' as const, tags: [], priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, depends_on: [], related: [] };
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
    link.card.title = 'Forbidden during child link';
    expect(() => validateCardStream(rows, '/canonical/card.jsonl', 'project')).toThrow(/child-link row mutates 'title'/);
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

    const changedType = structuredClone(rows);
    const tombstone = changedType.at(-1)!;
    if (tombstone.kind !== 'card-tombstone') throw new Error('Expected a terminal tombstone.');
    tombstone.final_card.type = 'goal';
    expect(() => validateCardStream(changedType, path, card.id)).toThrow(/invalid tombstone/);
    expect(() => validateCardStream([...rows, rows[0]!], path, card.id)).toThrow(/invalid tombstone position/);
  });
});
