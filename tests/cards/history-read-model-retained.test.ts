import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../src/cards/card-service.js';
import { CardHistoryReader } from '../../src/cards/history-reader.js';
import { computeCardLogicalPath, orderedCardsForTree, toCardRefView, toCardView } from '../../src/application/read-models/card-view.js';
import { CardsReadModelService } from '../../src/application/read-models/cards-read-model.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('direct card history and operator read models', () => {
  it('reads immutable versions newest-first, diffs facts, and derives display paths from hierarchy order rather than ID text', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-history-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const first = cards.create({ type: 'goal', parent: 'project', title: 'First by position', brief: 'One', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const second = cards.create({ type: 'code', parent: 'project', title: 'Second by position', brief: 'Two', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.mutateCard(first.id, { title: 'Updated title' }, { actor: 'analyst', surface: 'web-chat', reason: 'rename' });
    const history = new CardHistoryReader({ projectRoot: root });

    expect(history.listCardHistory(first.id).map((entry) => entry.version_seq)).toEqual([1]);
    expect(history.getCardAt(first.id, 1).title).toBe('First by position');
    expect(history.diffCard(first.id, 1, 2)).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'title', before: 'First by position', after: 'Updated title' })]));
    expect(orderedCardsForTree(cards).map((card) => card.id)).toEqual(['project', first.id, second.id]);
    expect(computeCardLogicalPath(cards, first)).toBe('1');
    expect(computeCardLogicalPath(cards, second)).toBe('2');
    expect(toCardView(cards, cards.read(first.id)!)).toMatchObject({ id: first.id, logical_path: '1', operator_summary: { terminal: false } });
    const missing = 'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(toCardRefView(cards, missing)).toEqual({ id: missing, logical_path: null, title: null, missing: true });
  });

  it('keeps every card-domain operator read opaque after tombstone', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-history-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const card = cards.create({ type: 'code', parent: 'project', title: 'Before', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.mutateCard(card.id, { title: 'After' }, { actor: 'analyst', surface: 'web-chat', reason: 'rename' });
    cards.deleteSubtrees([card.id], { actor: 'analyst', surface: 'runtime', reason: 'delete' }, () => true);
    const readModel = new CardsReadModelService(root, cards, { getRuntimeState: () => { throw new Error('unused'); } });

    expect(readModel.getCard(card.id)).toMatchObject({ statusCode: 404 });
    expect(readModel.listHistory(card.id)).toMatchObject({ statusCode: 404 });
    expect(readModel.getHistoryEntry(card.id, '2')).toMatchObject({ statusCode: 404 });
    expect(readModel.diffCard(card.id, { from: '1', to: '2' })).toMatchObject({ statusCode: 404 });
  });
});
