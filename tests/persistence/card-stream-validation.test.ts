import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../src/cards/card-service.js';
import { validateCardStream, type CardStreamRow } from '../../src/persistence/canonical-card-artifacts.js';
import { readCardArtifacts } from '../../src/persistence/card-files.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function cardRows(initialType: 'goal' | 'code'): { id: string; rows: CardStreamRow[] } {
  const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
  roots.push(root);
  initProjectTree(root);
  const cards = new CardService(root, undefined, undefined, () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
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
