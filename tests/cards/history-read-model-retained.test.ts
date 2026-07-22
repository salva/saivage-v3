import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../helpers/canonical-project.js';
import { computeCardLogicalPath, orderedCardsForTree, toCardView } from '../../src/application/read-models/card-view.js';
import { CardsReadModelService } from '../../src/application/read-models/cards-read-model.js';
import { ValidationErrorSchema } from '../../src/contracts/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('direct card history and operator read models', () => {
  it('projects stopped through hierarchy, detail, history, and operator actions without changing response shapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-history-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const card = cards.create({ type: 'code', parent: 'project', title: 'Stopped', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.setStatus(card.id, 'running');
    cards.stopRunningForRecovery(card.id);
    const readModel = new CardsReadModelService(root, cards, { getRuntimeState: () => null });

    const detail = readModel.getCard(card.id);
    expect(detail).toMatchObject({ body: { card: { lifecycle: { status: 'stopped' }, allowedActions: ['card.start', 'card.cancel', 'card.delete'], operator_summary: { blocked: false, hasError: false, error: null, completedAt: null, stale: false } } } });
    expect((detail.body as { card: { operator_summary: unknown } }).card.operator_summary).not.toHaveProperty('terminal');
    expect(readModel.getChildren('project')).toMatchObject({ body: { children: [{ id: card.id, lifecycle: { status: 'stopped' } }] } });
    expect(cards.listCardHistory(card.id)).toMatchObject({ kind: 'found', value: [expect.objectContaining({ snapshot: expect.objectContaining({ lifecycle: expect.objectContaining({ status: 'running' }) }) }), expect.objectContaining({ snapshot: expect.objectContaining({ lifecycle: expect.objectContaining({ status: 'backlog' }) }) })] });
  });

  it('reads immutable versions newest-first, diffs facts, and derives display paths from hierarchy order rather than ID text', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-history-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const first = cards.create({ type: 'goal', parent: 'project', title: 'First by position', bootstrap_content: 'One', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const second = cards.create({ type: 'code', parent: 'project', title: 'Second by position', bootstrap_content: 'Two', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.editCard(first.id, { title: 'Updated title' });
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
    const readModel = new CardsReadModelService(root, cards, { getRuntimeState: () => null });
    expect(readModel.diffCard(first.id, { from: 2, to: 1 })).toEqual({
      statusCode: 400,
      body: { error: 'Invalid diff pivots', from: 2, to: 1 },
    });
    expect(orderedCardsForTree(cards).map((card) => card.id)).toEqual(['project', first.id, second.id]);
    expect(computeCardLogicalPath(cards, first)).toBe('1');
    expect(computeCardLogicalPath(cards, second)).toBe('2');
    const firstView = toCardView(cards, cards.read(first.id)!);
    expect(firstView).toMatchObject({ card: { id: first.id }, status: 'backlog', parent: 'project', logical_path: '1', operator_summary: { blocked: false, hasError: false, stale: false } });
    expect(firstView.operator_summary).not.toHaveProperty('terminal');
  });

  it('keeps every card-domain operator read opaque after tombstone', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-history-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const card = cards.create({ type: 'code', parent: 'project', title: 'Before', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.editCard(card.id, { title: 'After' });
    cards.deleteSubtrees([card.id], () => true);
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
    const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
    for (const invalid of invalidValues) {
      const sequenceResult = readModel.getHistoryEntry('project', invalid);
      const expectedSequenceBody = {
        error: 'ValidationError',
        message: 'History sequence must be a positive safe integer',
        issues: [{ path: 'seq', message: 'History sequence must be a positive safe integer' }],
      };
      expect(sequenceResult).toEqual({ statusCode: 400, body: expectedSequenceBody });
      expect(ValidationErrorSchema.parse(sequenceResult.body)).toEqual(expectedSequenceBody);

      for (const path of ['from', 'to'] as const) {
        const pivotResult = readModel.diffCard('project', { [path]: invalid });
        const message = `Diff ${path} pivot must be a positive safe integer`;
        const expectedPivotBody = { error: 'ValidationError', message, issues: [{ path, message }] };
        expect(pivotResult).toEqual({ statusCode: 400, body: expectedPivotBody });
        expect(ValidationErrorSchema.parse(pivotResult.body)).toEqual(expectedPivotBody);
      }
    }
    const bothInvalid = readModel.diffCard('project', { from: 0, to: -1 });
    expect(bothInvalid.body).toMatchObject({ issues: [{ path: 'from' }] });
    expect(entry).not.toHaveBeenCalled();
    expect(diff).not.toHaveBeenCalled();
    expect(readModel.getHistoryEntry('project', 1)).toMatchObject({ statusCode: 404 });
    expect(entry).toHaveBeenCalledWith('project', 1);
    readModel.diffCard('project', { from: 1, to: 'current' });
    readModel.diffCard('project', { from: 'last', to: 1 });
    expect(diff).toHaveBeenNthCalledWith(1, 'project', { fromSeq: 1, toSeq: 'current' });
    expect(diff).toHaveBeenNthCalledWith(2, 'project', { fromSeq: 'last', toSeq: 1 });
  });
});
