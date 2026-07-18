import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultAnalystBriefRecordMutationService, DefaultAnalystCardMutationService } from '../../src/application/analyst-mutation-services.js';
import { CardService } from '../../src/cards/card-service.js';
import type { CardRecord } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const FIRST = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND = 'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('analyst card mutation service deletion', () => {
  it('delegates the complete requested root set to one atomic service preflight and returns deterministic deletion data', () => {
    const deleteSubtrees = jest.fn((ids: readonly string[], context: unknown, allowed: (card: CardRecord) => boolean) => {
      expect(ids).toEqual([FIRST, SECOND, FIRST]);
      expect(context).toEqual({ actor: 'analyst', surface: 'runtime', reason: 'analyst subtree deletion' });
      expect(allowed({ status: 'backlog' } as CardRecord)).toBe(true);
      expect(allowed({ status: 'running' } as CardRecord)).toBe(false);
      return { requested: [FIRST, SECOND], deleted: [SECOND, FIRST] };
    });
    const service = new DefaultAnalystCardMutationService({ deleteSubtrees } as unknown as CardService, 'web-chat');

    expect(service.delete([FIRST, SECOND, FIRST])).toEqual({
      success: true,
      data: { deleted: [SECOND, FIRST], top_level_deleted: [FIRST, SECOND] },
    });
    expect(deleteSubtrees).toHaveBeenCalledTimes(1);
  });

  it('returns one failure without a partial-success payload when complete preflight rejects', () => {
    const deleteSubtrees = jest.fn(() => { throw new Error(`Card '${SECOND}' cannot be deleted`); });
    const service = new DefaultAnalystCardMutationService({ deleteSubtrees } as unknown as CardService, 'web-chat');

    expect(service.delete([FIRST, SECOND])).toEqual({ success: false, error: `Card '${SECOND}' cannot be deleted` });
    expect(deleteSubtrees).toHaveBeenCalledTimes(1);
  });
});

describe('analyst stopped card mutations', () => {
  it('admits stopped as dormant for existing create, cancel, delete, and reorder surfaces', () => {
    const stopped = { id: FIRST, type: 'goal', parent: 'project', status: 'stopped' } as CardRecord;
    const store = {
      read: jest.fn((id: string) => id === FIRST ? stopped : null),
      getDescendantIds: jest.fn(() => []),
      listChildren: jest.fn(() => []),
    } as unknown as CardService;
    const service = new DefaultAnalystCardMutationService(store, 'web-chat');

    expect(service.validateCreate({ type: 'code', parent: FIRST, title: 'child', brief: 'brief' })).toEqual({ allowed: true });
    expect(service.validateCancel(FIRST)).toEqual({ allowed: true });
    expect(service.validateDelete([FIRST])).toEqual({ allowed: true });
    expect(service.validateReorder(FIRST, [])).toEqual({ allowed: true });
  });

  it('writes a stopped brief and preserves stopped lifecycle', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-stopped-brief-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const card = cards.create({ type: 'code', parent: 'project', title: 'Stopped work', brief: '# Goal\nOld\n# Instructions\nOld\n# Acceptance Criteria\nOld', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      cards.setStatus(card.id, 'running');
      cards.stopRunningForRecovery(card.id);
      const service = new DefaultAnalystBriefRecordMutationService(root, cards, () => ({ ok: true, notificationId: 'n' }));

      expect(service.write(`record:///brief.md?card=${card.id}&v=next`, '# Goal\nNew\n# Instructions\nNew\n# Acceptance Criteria\nNew')).toMatchObject({ success: true });
      expect(cards.read(card.id)).toMatchObject({ status: 'stopped', lifecycle: { status: 'stopped' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('analyst child reorder propagation', () => {
  function reorderHarness(result: ReturnType<CardService['reorderChildren']>) {
    const parent = { id: 'project', type: 'project', parent: null, status: 'backlog' } as CardRecord;
    const reorderChildren = jest.fn(() => result);
    const getAncestors = jest.fn(() => [] as string[]);
    const setStatus = jest.fn();
    const store = { read: jest.fn(() => parent), reorderChildren, getAncestors, setStatus } as unknown as CardService;
    const notifyCard = jest.fn(() => ({ ok: true as const, notificationId: 'notification' }));
    const service = new DefaultAnalystCardMutationService(store, 'web-chat', notifyCard);
    return { service, reorderChildren, getAncestors, setStatus, notifyCard };
  }

  it('returns a zero-change success without status propagation or notification', () => {
    const test = reorderHarness({ ok: true, changed: 0 });
    expect(test.service.reorder('project', [])).toEqual({ success: true, data: { parent_id: 'project', changed: 0 } });
    expect(test.getAncestors).not.toHaveBeenCalled();
    expect(test.setStatus).not.toHaveBeenCalled();
    expect(test.notifyCard).not.toHaveBeenCalled();
  });

  it('propagates exactly once for a real reorder', () => {
    const test = reorderHarness({ ok: true, changed: 2 });
    expect(test.service.reorder('project', [])).toEqual({ success: true, data: { parent_id: 'project', changed: 2 } });
    expect(test.getAncestors).toHaveBeenCalledTimes(1);
    expect(test.notifyCard).toHaveBeenCalledTimes(1);
  });

  it('does not propagate a reorder mismatch', () => {
    const test = reorderHarness({ ok: false, reason: 'ordered child ids do not match current children', missing: [FIRST], extra: [] });
    expect(test.service.reorder('project', [])).toMatchObject({ success: false, error: 'reorder_set_mismatch' });
    expect(test.getAncestors).not.toHaveBeenCalled();
    expect(test.setStatus).not.toHaveBeenCalled();
    expect(test.notifyCard).not.toHaveBeenCalled();
  });
});
