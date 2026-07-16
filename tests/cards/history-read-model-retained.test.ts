import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../src/cards/card-service.js';
import { CardHistoryReader } from '../../src/cards/history-reader.js';
import { computeCardDisplayPath, orderedCardsForTree, toCardRefView, toCardView } from '../../src/application/read-models/card-view.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('direct card history and operator read models', () => {
  it('reads immutable versions newest-first, diffs facts, and derives display paths from hierarchy order rather than UUID text', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-history-'));
    roots.push(root);
    initProjectTree(root);
    const ids = ['ffffffff-ffff-4fff-8fff-ffffffffffff', '11111111-1111-4111-8111-111111111111'];
    const cards = new CardService(root, undefined, undefined, () => ids.shift()!);
    const first = cards.create({ type: 'goal', parent: 'project', depth: 1, title: 'First by position', brief: 'One', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const second = cards.create({ type: 'code', parent: 'project', depth: 1, title: 'Second by position', brief: 'Two', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.mutateCard(first.id, { title: 'Updated title' }, { actor: 'analyst', surface: 'web-chat', reason: 'rename' });
    const history = new CardHistoryReader({ projectRoot: root, read: (id) => cards.read(id) });

    expect(history.listCardHistory(first.id).map((entry) => entry.version_seq)).toEqual([1]);
    expect(history.getCardAt(first.id, 1).title).toBe('First by position');
    expect(history.diffCard(first.id, 1, 2)).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'title', before: 'First by position', after: 'Updated title' })]));
    expect(orderedCardsForTree(cards).map((card) => card.id)).toEqual(['project', first.id, second.id]);
    expect(computeCardDisplayPath(cards, first)).toBe('1');
    expect(computeCardDisplayPath(cards, second)).toBe('2');
    expect(toCardView(cards, cards.read(first.id)!)).toMatchObject({ id: first.id, display_path: '1', operator_summary: { terminal: false } });
    expect(toCardRefView(cards, '22222222-2222-4222-8222-222222222222')).toEqual({ id: '22222222-2222-4222-8222-222222222222', display_path: null, title: null, missing: true });
  });
});
