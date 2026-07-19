import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../src/cards/card-service.js';
import { computeCardLogicalPath, orderedCardsForTree, toCardRefView, toCardView } from '../../src/application/read-models/card-view.js';
import { CardsReadModelService } from '../../src/application/read-models/cards-read-model.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('direct card history and operator read models', () => {
  it('projects stopped through hierarchy, detail, history, and operator actions without changing response shapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-history-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const card = cards.create({ type: 'code', parent: 'project', title: 'Stopped', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.setStatus(card.id, 'running');
    cards.stopRunningForRecovery(card.id);
    const readModel = new CardsReadModelService(root, cards, { getRuntimeState: () => null });

    const detail = readModel.getCard(card.id);
    expect(detail).toMatchObject({ body: { card: { status: 'stopped', lifecycle: { status: 'stopped' }, allowedActions: ['card.start', 'card.cancel', 'card.delete'], operator_summary: { lifecycleStatus: 'stopped', blocked: false, hasError: false, error: null, completedAt: null, stale: false, actionCount: 0 } } } });
    expect((detail.body as { card: { operator_summary: unknown } }).card.operator_summary).not.toHaveProperty('terminal');
    expect(readModel.getChildren('project')).toMatchObject({ body: { children: [{ id: card.id, status: 'stopped' }] } });
    expect(cards.listCardHistory(card.id)).toMatchObject({ kind: 'found', value: [expect.objectContaining({ snapshot: expect.objectContaining({ status: 'running' }) }), expect.objectContaining({ snapshot: expect.objectContaining({ status: 'backlog' }) })] });
  });

  it('reads immutable versions newest-first, diffs facts, and derives display paths from hierarchy order rather than ID text', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-history-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const first = cards.create({ type: 'goal', parent: 'project', title: 'First by position', brief: 'One', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const second = cards.create({ type: 'code', parent: 'project', title: 'Second by position', brief: 'Two', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.mutateCard(first.id, { title: 'Updated title' }, { actor: 'analyst', surface: 'web-chat', reason: 'rename' });
    const history = cards.listCardHistory(first.id);
    expect(history.kind).toBe('found');
    if (history.kind !== 'found') throw new Error('expected card history');
    expect(history.value.map((entry) => entry.version_seq)).toEqual([1]);
    const entry = cards.getCardHistoryEntry(first.id, 1);
    expect(entry.kind).toBe('found');
    if (entry.kind !== 'found') throw new Error('expected history entry');
    expect(entry.value.snapshot.title).toBe('First by position');
    const diff = cards.diffCardHistory(first.id, { fromSeq: 1, toSeq: 2 });
    expect(diff.kind).toBe('found');
    if (diff.kind !== 'found') throw new Error('expected card diff');
    expect(diff.diff).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'title', before: 'First by position', after: 'Updated title' })]));
    expect(orderedCardsForTree(cards).map((card) => card.id)).toEqual(['project', first.id, second.id]);
    expect(computeCardLogicalPath(cards, first)).toBe('1');
    expect(computeCardLogicalPath(cards, second)).toBe('2');
    const firstView = toCardView(cards, cards.read(first.id)!);
    expect(firstView).toMatchObject({ id: first.id, logical_path: '1', operator_summary: { lifecycleStatus: 'backlog', blocked: false, hasError: false, stale: false } });
    expect(firstView.operator_summary).not.toHaveProperty('terminal');
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
    expect(readModel.getHistoryEntry(card.id, 2)).toMatchObject({ statusCode: 404 });
    expect(readModel.diffCard(card.id, { from: 1, to: 2 })).toMatchObject({ statusCode: 404 });
  });

  it('rejects invalid application sequences before invoking CardService', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-history-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const entry = jest.spyOn(cards, 'getCardHistoryEntry');
    const diff = jest.spyOn(cards, 'diffCardHistory');
    const readModel = new CardsReadModelService(root, cards, { getRuntimeState: () => { throw new Error('unused'); } });
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(readModel.getHistoryEntry('project', invalid)).toMatchObject({ statusCode: 400 });
      expect(readModel.diffCard('project', { from: invalid })).toMatchObject({ statusCode: 400 });
      expect(readModel.diffCard('project', { to: invalid })).toMatchObject({ statusCode: 400 });
    }
    expect(entry).not.toHaveBeenCalled();
    expect(diff).not.toHaveBeenCalled();
    expect(readModel.getHistoryEntry('project', 1)).toMatchObject({ statusCode: 404 });
    expect(entry).toHaveBeenCalledWith('project', 1);
  });
});
