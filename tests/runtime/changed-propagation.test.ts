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

describe('Analyst brief status effects', () => {
  it.each([
    { status: 'backlog', reopens: false },
    { status: 'running', reopens: false },
    { status: 'stopped', reopens: false },
    { status: 'blocked', reopens: true },
    { status: 'done', reopens: true },
    { status: 'failed', reopens: true },
  ] as const)('$status is accepted and reopen=$reopens', ({ status, reopens }) => {
    const card = record('card-a', status, 'code');
    const setStatus = jest.fn();
    const store = { read: () => card, getAncestors: () => [], setStatus } as unknown as CardService;
    const notify = jest.fn(() => ({ ok: true as const, notificationId: 'n' }));

    expect(propagateAnalystBriefEdit(store, card.id, { kind: 'analyst_edit', summary: 'edited' }, notify).flipped)
      .toEqual(reopens ? [{ card_id: card.id, previous_status: status }] : []);
    expect(setStatus).toHaveBeenCalledTimes(reopens ? 1 : 0);
  });

  it.each(['changed', 'cancelled'] as const)('rejects %s', (status) => {
    const card = record('card-a', status, 'code');
    const store = { read: () => card, getAncestors: () => [], setStatus: jest.fn() } as unknown as CardService;
    expect(() => propagateAnalystBriefEdit(store, card.id, { kind: 'analyst_edit', summary: 'edited' }, () => ({ ok: true, notificationId: 'n' })))
      .toThrow(`does not support target card status '${status}'`);
  });
});
