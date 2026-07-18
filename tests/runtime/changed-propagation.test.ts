import { describe, expect, it, jest } from '@jest/globals';

import { propagateAnalystBriefEdit, propagateChange } from '../../src/runtime/changed-propagation.js';
import type { CardRecord, CardStatus } from '../../src/schemas/index.js';
import type { CardService } from '../../src/cards/card-api.js';

function record(id: string, status: CardStatus, type: CardRecord['type']): CardRecord {
  return { id, status, type } as CardRecord;
}

describe('stopped changed propagation', () => {
  it('preserves stopped cards while continuing to the existing running notification boundary', () => {
    const cards = new Map([
      ['card-a', record('card-a', 'stopped', 'code')],
      ['card-b', record('card-b', 'stopped', 'goal')],
      ['project', record('project', 'running', 'project')],
    ]);
    const setStatus = jest.fn();
    const store = { read: (id: string) => cards.get(id) ?? null, getAncestors: () => ['project', 'card-b'], setStatus } as unknown as CardService;
    const notify = jest.fn((_: string) => ({ ok: true as const, notificationId: 'n' }));

    expect(propagateChange(store, 'card-a', { kind: 'analyst_edit', summary: 'edited' }, notify)).toEqual({ flipped: [] });
    expect(setStatus).not.toHaveBeenCalled();
    expect(notify.mock.calls.map(([id]) => id)).toEqual(['card-a', 'project']);
  });

  it('preserves a stopped brief target and stopped ancestors and queues their later context', () => {
    const cards = new Map([
      ['card-a', record('card-a', 'stopped', 'code')],
      ['card-b', record('card-b', 'stopped', 'goal')],
      ['project', record('project', 'stopped', 'project')],
    ]);
    const setStatus = jest.fn();
    const store = { read: (id: string) => cards.get(id) ?? null, getAncestors: () => ['project', 'card-b'], setStatus } as unknown as CardService;
    const notify = jest.fn((_: string) => ({ ok: true as const, notificationId: 'n' }));

    expect(propagateAnalystBriefEdit(store, 'card-a', { kind: 'analyst_edit', summary: 'brief edited' }, notify)).toEqual({ flipped: [] });
    expect(setStatus).not.toHaveBeenCalled();
    expect(notify.mock.calls.map(([id]) => id)).toEqual(['card-a', 'card-b', 'project']);
  });
});
