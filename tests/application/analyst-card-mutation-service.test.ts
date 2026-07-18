import { describe, expect, it, jest } from '@jest/globals';

import { DefaultAnalystCardMutationService } from '../../src/application/analyst-mutation-services.js';
import type { CardService } from '../../src/cards/card-api.js';
import type { CardRecord } from '../../src/schemas/index.js';

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
