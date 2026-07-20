import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAnalystMutationServices } from '../../src/application/analyst-mutation-services.js';
import { CardService } from '../../src/cards/card-service.js';
import type { CardRecord } from '../../src/schemas/index.js';
import { initProjectTree, testAnalystMutationServices } from '../helpers/canonical-project.js';

const FIRST = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND = 'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function services(store: CardService, notifyCard = jest.fn(() => ({ ok: true as const, notificationId: 'notification' })), cancelCard = jest.fn(async () => ({ card_id: FIRST, status: 'cancelled' as const, cancelled_card_ids: [FIRST] }))) {
  return createAnalystMutationServices({ projectRoot: '/tmp/analyst-mutation-test', store, configAuthority: { applyChange: jest.fn() } as never, surface: 'web-chat', notifyCard, cancelCard });
}

describe('analyst card mutation service deletion', () => {
  it('delegates the complete requested root set to one atomic service preflight and returns deterministic deletion data', () => {
    const deleteSubtrees = jest.fn((ids: readonly string[], context: unknown, allowed: (card: CardRecord) => boolean) => {
      expect(ids).toEqual([FIRST, SECOND, FIRST]);
      expect(context).toEqual({ actor: 'analyst', surface: 'runtime', reason: 'analyst subtree deletion' });
      expect(allowed({ status: 'backlog' } as CardRecord)).toBe(true);
      expect(allowed({ status: 'running' } as CardRecord)).toBe(false);
      return { requested: [FIRST, SECOND], deleted: [SECOND, FIRST] };
    });
    const service = services({ deleteSubtrees } as unknown as CardService).cards;

    expect(service.delete([FIRST, SECOND, FIRST])).toEqual({
      kind: 'returned', success: true,
      data: { deleted: [SECOND, FIRST], top_level_deleted: [FIRST, SECOND] },
    });
    expect(deleteSubtrees).toHaveBeenCalledTimes(1);
  });

  it('returns one failure without a partial-success payload when complete preflight rejects', () => {
    const deleteSubtrees = jest.fn(() => { throw new Error(`Card '${SECOND}' cannot be deleted`); });
    const service = services({ deleteSubtrees } as unknown as CardService).cards;

    expect(() => service.delete([FIRST, SECOND])).toThrow(`Card '${SECOND}' cannot be deleted`);
    expect(deleteSubtrees).toHaveBeenCalledTimes(1);
  });
});

describe('analyst stopped card mutations', () => {
  it('admits a stopped parent for creation and invokes the owner once', () => {
    const stopped = { id: FIRST, type: 'goal', parent: 'project', status: 'stopped' } as CardRecord;
    const child = { id: SECOND, type: 'code', parent: FIRST, status: 'backlog', lifecycle: { status: 'backlog' }, title: 'child' } as CardRecord;
    const store = {
      read: jest.fn((id: string) => id === FIRST ? stopped : null),
      getDescendantIds: jest.fn(() => []),
      listChildren: jest.fn((id: string) => id === 'project' ? [FIRST] : [SECOND]), create: jest.fn(() => child),
    } as unknown as CardService;
    const bundle = services(store);
    expect(bundle.cards.create({ type: 'code', parent: FIRST, title: 'child', brief: 'brief' })).toMatchObject({ kind: 'returned', success: true });
    expect((store.create as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'backlog', allowed: true }, { status: 'running', allowed: true }, { status: 'blocked', allowed: true }, { status: 'changed', allowed: true },
    { status: 'stopped', allowed: true }, { status: 'done', allowed: false }, { status: 'failed', allowed: true }, { status: 'cancelled', allowed: false },
  ] as const)('applies cancellation membership to $status', async ({ status, allowed }) => {
    const target = { id: FIRST, type: 'code', parent: 'project', status } as CardRecord;
    const store = { read: () => target, getDescendantIds: () => [] } as unknown as CardService;
    const cancelCard = jest.fn(async () => ({ card_id: FIRST, status: 'cancelled' as const, cancelled_card_ids: [FIRST] }));
    const outcome = await services(store, undefined, cancelCard).cards.cancel(FIRST);
    expect(outcome.kind !== 'denied').toBe(allowed);
    expect(cancelCard).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it.each([
    { status: 'backlog', allowed: true }, { status: 'running', allowed: false }, { status: 'blocked', allowed: true }, { status: 'changed', allowed: true },
    { status: 'stopped', allowed: true }, { status: 'done', allowed: false }, { status: 'failed', allowed: false }, { status: 'cancelled', allowed: false },
  ] as const)('applies create-parent membership and Analyst running denial to $status', ({ status, allowed }) => {
    const parent = { id: FIRST, type: 'goal', parent: 'project', status } as CardRecord;
    const child = { id: SECOND, type: 'code', parent: FIRST, status: 'backlog', lifecycle: { status: 'backlog' }, title: 'child' } as CardRecord;
    const create = jest.fn(() => child);
    const store = { read: () => parent, create, listChildren: (id: string) => id === 'project' ? [FIRST] : [SECOND] } as unknown as CardService;
    const outcome = services(store).cards.create({ type: 'code', parent: FIRST, title: 'child', brief: 'brief' });
    expect(outcome.kind !== 'denied').toBe(allowed);
    expect(create).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it('writes a stopped brief and preserves stopped lifecycle', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-stopped-brief-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const card = cards.create({ type: 'code', parent: 'project', title: 'Stopped work', brief: '# Goal\nOld\n# Instructions\nOld\n# Acceptance Criteria\nOld', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      cards.setStatus(card.id, 'running');
      cards.stopRunningForRecovery(card.id);
      const service = testAnalystMutationServices(root, cards, () => ({ ok: true, notificationId: 'n' })).briefRecords;

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
    const store = { read: jest.fn(() => parent), listChildren: jest.fn(() => []), reorderChildren, getAncestors, setStatus } as unknown as CardService;
    const notifyCard = jest.fn(() => ({ ok: true as const, notificationId: 'notification' }));
    const service = services(store, notifyCard).cards;
    return { service, reorderChildren, getAncestors, setStatus, notifyCard };
  }

  it('returns a zero-change success without status propagation or notification', () => {
    const test = reorderHarness({ ok: true, changed: 0 });
    expect(test.service.reorder('project', [])).toEqual({ kind: 'returned', success: true, data: { parent_id: 'project', changed: 0 } });
    expect(test.getAncestors).not.toHaveBeenCalled();
    expect(test.setStatus).not.toHaveBeenCalled();
    expect(test.notifyCard).not.toHaveBeenCalled();
  });

  it('propagates exactly once for a real reorder', () => {
    const test = reorderHarness({ ok: true, changed: 2 });
    expect(test.service.reorder('project', [])).toEqual({ kind: 'returned', success: true, data: { parent_id: 'project', changed: 2 } });
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

describe('other Analyst mutation facets', () => {
  it('calls the configuration authority exactly once through apply', () => {
    const applyChange = jest.fn(() => ({ success: true, requires_restart: false }));
    const bundle = createAnalystMutationServices({ projectRoot: '/tmp/config-test', store: {} as CardService, configAuthority: { applyChange } as never, surface: 'web-chat', cancelCard: jest.fn() as never });
    expect(bundle.config.apply({ kind: 'set_runtime_setting', key: 'continuous_improvement', value: false })).toMatchObject({ kind: 'returned', success: true });
    expect(applyChange).toHaveBeenCalledTimes(1);
  });

  it('relies on the notification owner result without a separate card read', () => {
    const read = jest.fn();
    const notifyCard = jest.fn(() => ({ ok: true as const, notificationId: 'queued' }));
    const bundle = services({ read } as unknown as CardService, notifyCard);
    expect(bundle.notifications.queue(FIRST, 'context', 'body')).toMatchObject({ kind: 'returned', success: true });
    expect(read).not.toHaveBeenCalled();
    expect(notifyCard).toHaveBeenCalledTimes(1);
  });

  it('edits from the fresh latest closed brief', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-fresh-brief-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const card = cards.create({ type: 'code', parent: 'project', title: 'Fresh brief', brief: '# Goal\nOld\n# Instructions\nOld\n# Acceptance Criteria\nOld', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      const open = cards.openRecord(card.id, 'brief.md');
      cards.editRecord(card.id, 'brief.md', open.version, '# Goal\nFresh current\n# Instructions\nFresh current\n# Acceptance Criteria\nFresh current');
      cards.closeRecord(card.id, 'brief.md', open.version, 'analyst', card.version_seq);
      const service = testAnalystMutationServices(root, cards).briefRecords;
      expect(service.edit(`record:///brief.md?card=${card.id}&v=next`, 'Fresh current', 'Newest', true)).toMatchObject({ kind: 'returned', success: true });
      expect(cards.readRecord(card.id, 'brief.md', 'latest').artifact.content).toContain('Newest');
      expect(cards.readRecord(card.id, 'brief.md', 'latest').artifact.content).not.toContain('Fresh current');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
