import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../src/cards/card-service.js';
import { cardStreamRowSchema, validateCardStream, type CardStreamRow } from '../../src/persistence/canonical-card-artifacts.js';
import { readCardArtifacts, reserveChildCardId } from '../../src/persistence/card-files.js';
import { parseGrowingFile } from '../../src/persistence/growing-file.js';
import { cardStreamFile } from '../../src/persistence/layout.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function cardRows(initialType: 'goal' | 'code'): { id: string; rows: CardStreamRow[] } {
  const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
  roots.push(root);
  initProjectTree(root);
  const cards = new CardService(root);
  const card = cards.create({
    type: initialType,
    parent: 'project',
    title: 'Immutable type',
    brief: 'Validate the card stream.',
    status: 'backlog',
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
    related: [],
  });
  cards.update(card.id, { title: 'Still the same type' });
  return { id: card.id, rows: structuredClone(readCardArtifacts(root, card.id).artifacts) };
}

describe('card stream type immutability', () => {
  it.each<{ initialType: 'goal' | 'code'; changedType: 'goal' | 'code' }>([
    { initialType: 'goal', changedType: 'code' },
    { initialType: 'code', changedType: 'goal' },
  ])('rejects a later $initialType to $changedType type transition', ({ initialType, changedType }) => {
    const { id, rows } = cardRows(initialType);
    const later = rows[1]!;
    if (later.kind !== 'card-version') throw new Error('Expected the second card stream row to be a card version.');
    later.card.type = changedType;

    expect(() => validateCardStream(rows, '/canonical/card.jsonl', id))
      .toThrow("mutates immutable field 'type'");
  });

  it('accepts a later version that retains its initial type', () => {
    const { id, rows } = cardRows('goal');

    expect(validateCardStream(rows, '/canonical/card.jsonl', id).current.card)
      .toMatchObject({ type: 'goal', title: 'Still the same type', version_seq: 2 });
  });
});

describe('card child reservations', () => {
  it('keeps reservations outside card versions and requires them before child links', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-reservation-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    cards.create({ type: 'code', parent: 'project', title: 'Reserved', brief: 'Reserved child', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const stream = readCardArtifacts(root, 'project');

    expect(stream.rows.map((row) => row.kind)).toEqual(['card-version', 'card-child-reservation', 'card-version']);
    expect(stream.artifacts.map((row) => row.version)).toEqual([1, 2]);
    expect(stream.reservations).toEqual([{ kind: 'card-child-reservation', format_version: 1, card_id: 'project', segment: 'a', child_id: 'card-a' }]);

    expect(() => validateCardStream(stream.rows.filter((row) => row.kind !== 'card-child-reservation'), '/canonical/card.jsonl', 'project'))
      .toThrow("links child 'card-a' without an immediately preceding matching reservation");
  });

  it('strictly validates reservation position, owner, sequence, and derived child identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-reservation-'));
    roots.push(root);
    initProjectTree(root);
    const initial = readCardArtifacts(root, 'project').rows;
    const reservation = { kind: 'card-child-reservation' as const, format_version: 1 as const, card_id: 'project' as const, segment: 'a', child_id: 'card-a' as const };
    expect(validateCardStream([...initial, reservation], '/canonical/card.jsonl', 'project').current.card.id).toBe('project');
    expect(() => validateCardStream([reservation, ...initial], '/canonical/card.jsonl', 'project')).toThrow(/position or owner/);
    expect(() => validateCardStream([...initial, { ...reservation, card_id: 'card-a' }], '/canonical/card.jsonl', 'project')).toThrow(/position or owner/);
    expect(() => validateCardStream([...initial, { ...reservation, segment: 'b', child_id: 'card-b' }], '/canonical/card.jsonl', 'project')).toThrow(/non-sequential/);
    expect(() => validateCardStream([...initial, { ...reservation, child_id: 'card-b' }], '/canonical/card.jsonl', 'project')).toThrow(/non-sequential/);
  });

  it('never revives a reservation after a newer reservation or an intervening card version', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-reservation-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    cards.create({ type: 'code', parent: 'project', title: 'First', brief: 'First child', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const linked = readCardArtifacts(root, 'project').rows;
    const reservationB = { kind: 'card-child-reservation' as const, format_version: 1 as const, card_id: 'project' as const, segment: 'b', child_id: 'card-b' as const };
    expect(() => validateCardStream([linked[0]!, linked[1]!, reservationB, linked[2]!], '/canonical/card.jsonl', 'project'))
      .toThrow(/immediately preceding matching reservation/);

    const anotherRoot = mkdtempSync(join(tmpdir(), 'saivage-card-stream-reservation-'));
    roots.push(anotherRoot);
    initProjectTree(anotherRoot);
    const another = new CardService(anotherRoot);
    another.update('project', { title: 'Intervening version' });
    another.create({ type: 'code', parent: 'project', title: 'First', brief: 'First child', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const rows = readCardArtifacts(anotherRoot, 'project').rows;
    expect(rows.map((row) => row.kind)).toEqual(['card-version', 'card-version', 'card-child-reservation', 'card-version']);
    expect(() => validateCardStream([rows[0]!, rows[2]!, rows[1]!, rows[3]!], '/canonical/card.jsonl', 'project'))
      .toThrow(/immediately preceding matching reservation/);
  });

  it('allows consecutive reservations but links only the newest immediately preceding one', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-reservation-'));
    roots.push(root);
    initProjectTree(root);
    expect(reserveChildCardId(root, 'project')).toBe('card-a');

    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Second', brief: 'Second child', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const stream = readCardArtifacts(root, 'project');
    expect(child.id).toBe('card-b');
    expect(cards.listChildren('project')).toEqual(['card-b']);
    expect(stream.rows.map((row) => row.kind)).toEqual(['card-version', 'card-child-reservation', 'card-child-reservation', 'card-version']);
    expect(stream.reservations.map((row) => row.child_id)).toEqual(['card-a', 'card-b']);
  });

  it('preserves immutable type and terminal tombstones with interleaved reservations', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-reservation-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const card = cards.create({ type: 'code', parent: 'project', title: 'Child', brief: 'Child', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    reserveChildCardId(root, card.id);
    cards.deleteSubtrees([card.id], { actor: 'analyst', surface: 'runtime', reason: 'delete' }, () => true);
    const path = cardStreamFile(root, card.id);
    const rows = parseGrowingFile(path, readFileSync(path, 'utf8'), cardStreamRowSchema);
    const validated = validateCardStream(rows, path, card.id);
    expect(validated.rows.map((row) => row.kind)).toEqual(['card-version', 'card-child-reservation', 'card-tombstone']);
    expect(validated.current.card.type).toBe('code');
    expect(validated.tombstone?.final_card.type).toBe('code');

    const changedType = structuredClone(rows);
    const tombstone = changedType.at(-1)!;
    if (tombstone.kind !== 'card-tombstone') throw new Error('Expected terminal tombstone.');
    tombstone.final_card.type = 'goal';
    expect(() => validateCardStream(changedType, path, card.id)).toThrow(/invalid tombstone/);
    expect(() => validateCardStream([...rows, { kind: 'card-child-reservation', format_version: 1, card_id: card.id, segment: 'b', child_id: `${card.id}-b` }], path, card.id)).toThrow(/tombstone position/);
  });
});
