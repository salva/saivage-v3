import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAnalystMutationServices } from '../../src/application/analyst-mutation-services.js';
import { CardService } from '../helpers/canonical-project.js';
import { cardViewSchema, type CardRecord, type CardStatus, type CardTypeName } from '../../src/schemas/index.js';
import { initProjectTree, testAnalystMutationServices, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { runtimeFailure, workflowResult } from '../helpers/workflow-result.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { toCardView } from '../../src/application/read-models/card-view.js';
import type { NotificationSubmissionPort } from '../../src/runtime/runtime-api.js';

const FIRST = 'card-a';
const SECOND = 'card-a-b';
function current(cards:CardService,id:string,name:string){const result=cards.readRecordCurrent(id,name);if(result.kind!=='found'||!result.value.projection)throw new Error('missing record');return result.value.projection;}
function historical(cards:CardService,id:string,name:string,version:number){const result=cards.readRecordVersion(id,name,version);if(result.kind!=='found')throw new Error('missing record version');return result.value.projection;}

function card(status: CardStatus, id = FIRST, type: CardTypeName = 'code'): CardRecord {
  const common = { id, type, child_membership: [], active_child_order: [], title: id, subtype: null, priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, created_at: '2026-07-20T00:00:00.000Z', updated_at: '2026-07-20T00:00:00.000Z', version_seq: 1, assigned_to: null, depends_on: [], metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null, pending_notifications: [] };
  switch (status) {
    case 'done': return { ...common, lifecycle: { status, result: workflowResult('DONE', 'done'), error: null, completed_at: '2026-07-20T00:00:00.000Z' } };
    case 'failed': return { ...common, lifecycle: { status, result: runtimeFailure('failed'), error: 'failed', completed_at: '2026-07-20T00:00:00.000Z' } };
    case 'blocked': return { ...common, lifecycle: { status, result: workflowResult('BLOCKED', 'blocked'), error: 'blocked', completed_at: null } };
    default: return { ...common, lifecycle: { status, result: null, error: null, completed_at: null } };
  }
}

function services(store: CardService, notifyCard: (...args: any[]) => any = jest.fn((_id: string, notification: { id: string }) => ({ ok: true as const, notificationId: notification.id })), cancelCard = jest.fn(async () => ({ card_id: FIRST, status: 'cancelled' as const, cancelled_card_ids: [FIRST] })), submitNotification: (...args: any[]) => any = jest.fn(async (cardId: string, notification: { id: string }) => ({ queued: true as const, cardId, notificationId: notification.id, interruption: { status: 'not_requested' as const } }))) {
  if (!('workflows' in store)) Object.assign(store, { workflows: TEST_WORKFLOWS });
  return createAnalystMutationServices({ store, configAuthority: { applyChange: jest.fn() } as never, notifyCard, submitNotification, cancelCard });
}

describe('analyst card mutation service deletion', () => {
  it('delegates the complete admitted root set to one service preflight and returns deterministic deletion data', () => {
    const deleteSubtrees = jest.fn((ids: readonly string[], allowed: (card: CardRecord) => boolean) => {
      expect(ids).toEqual([FIRST, SECOND, FIRST]);
      expect(allowed(card('backlog'))).toBe(true);
      expect(allowed(card('running'))).toBe(false);
      return { requested: [FIRST, SECOND], deleted: [SECOND, FIRST] };
    });
    const service = services({ deleteSubtrees, read: (id: string) => card('backlog', id), getDescendantIds: () => [] } as unknown as CardService).cards;

    expect(service.delete([FIRST, SECOND, FIRST])).toEqual({
      kind: 'returned', success: true,
      data: { deleted: [SECOND, FIRST], top_level_deleted: [FIRST, SECOND] },
    });
    expect(deleteSubtrees).toHaveBeenCalledTimes(1);
  });

  it('returns one failure without a partial-success payload when complete preflight rejects', () => {
    const deleteSubtrees = jest.fn(() => { throw new Error(`Card '${SECOND}' cannot be deleted`); });
    const service = services({ deleteSubtrees, read: (id: string) => card('backlog', id), getDescendantIds: () => [] } as unknown as CardService).cards;

    expect(() => service.delete([FIRST, SECOND])).toThrow(`Card '${SECOND}' cannot be deleted`);
    expect(deleteSubtrees).toHaveBeenCalledTimes(1);
  });
});

describe('analyst stopped card mutations', () => {
  it('admits a stopped parent for creation and invokes the owner once', () => {
    const stopped = card('stopped', FIRST, 'goal');
    const child = card('backlog', SECOND);
    const store = {
      read: jest.fn((id: string) => id === FIRST ? stopped : null),
      getDescendantIds: jest.fn(() => []),
      getAncestors: jest.fn(() => []),
      listChildren: jest.fn((id: string) => id === 'project' ? [FIRST] : id === FIRST ? [SECOND] : []), create: jest.fn(() => child),
    } as unknown as CardService;
    const bundle = services(store);
    const outcome = bundle.cards.create({ type: 'code', parent: FIRST, title: 'child', bootstrap_content: 'brief' });
    expect(outcome).toMatchObject({ kind: 'returned', success: true });
    if (outcome.kind !== 'returned' || !outcome.success) throw new Error('Expected creation success.');
    const { propagation, ...view } = outcome.data as Record<string, unknown>;
    expect(propagation).toEqual({ ok: true });
    expect(cardViewSchema.parse(view).card).not.toHaveProperty('pending_notifications');
    expect((store.create as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'backlog', allowed: true }, { status: 'running', allowed: true }, { status: 'blocked', allowed: true }, { status: 'changed', allowed: true },
    { status: 'stopped', allowed: true }, { status: 'done', allowed: false }, { status: 'failed', allowed: true }, { status: 'cancelled', allowed: false },
  ] as const)('applies cancellation membership to $status', async ({ status, allowed }) => {
    const target = card(status);
    const store = { read: () => target, getDescendantIds: () => [], getParent: () => 'project' } as unknown as CardService;
    const cancelCard = jest.fn(async () => ({ card_id: FIRST, status: 'cancelled' as const, cancelled_card_ids: [FIRST] }));
    const outcome = await services(store, undefined, cancelCard).cards.cancel(FIRST);
    expect(outcome.kind !== 'denied').toBe(allowed);
    expect(cancelCard).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it.each([
    { status: 'backlog', allowed: true }, { status: 'running', allowed: false }, { status: 'blocked', allowed: true }, { status: 'changed', allowed: true },
    { status: 'stopped', allowed: true }, { status: 'done', allowed: false }, { status: 'failed', allowed: false }, { status: 'cancelled', allowed: false },
  ] as const)('applies create-parent membership and Analyst running denial to $status', ({ status, allowed }) => {
    const parent = card(status, FIRST, 'goal');
    const child = card('backlog', SECOND);
    const create = jest.fn(() => child);
    const store = { read: () => parent, create, listChildren: (id: string) => id === 'project' ? [FIRST] : id === FIRST ? [SECOND] : [] } as unknown as CardService;
    const outcome = services(store).cards.create({ type: 'code', parent: FIRST, title: 'child', bootstrap_content: 'brief' });
    expect(outcome.kind !== 'denied').toBe(allowed);
    expect(create).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it('writes a stopped brief and preserves stopped lifecycle', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-stopped-brief-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const card = cards.create({ type: 'code', parent: 'project', title: 'Stopped work', bootstrap_content: '# Goal\nOld\n# Instructions\nOld\n# Acceptance Criteria\nOld', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      cards.setStatus(card.id, 'running');
      cards.stopRunning(card.id);
      const service = testAnalystMutationServices(root, cards, (_id, notification) => ({ ok: true, notificationId: notification.id })).recordMutations;

      expect(service.write(`record:///brief.md?card=${card.id}`, '# Goal\nNew\n# Instructions\nNew\n# Acceptance Criteria\nNew')).toMatchObject({ success: true });
      expect(cards.read(card.id)).toMatchObject({ lifecycle: { status: 'stopped' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('analyst child reorder propagation', () => {
  function reorderHarness(result: ReturnType<CardService['reorderChildren']>) {
    const parent = card('backlog', 'project', 'project');
    const reorderChildren = jest.fn((_parentId: string, _orderedChildIds: readonly string[]) => result);
    const getAncestors = jest.fn(() => [] as string[]);
    const setStatus = jest.fn();
    const store = { read: jest.fn(() => parent), listChildren: jest.fn(() => []), reorderChildren, getAncestors, setStatus } as unknown as CardService;
    const notifyCard = jest.fn((_id: string, notification: { id: string }) => ({ ok: true as const, notificationId: notification.id }));
    const service = services(store, notifyCard).cards;
    return { service, reorderChildren, getAncestors, setStatus, notifyCard };
  }

  it('returns a zero-change success without status propagation or notification', () => {
    const test = reorderHarness({ ok: true, changed: 0 });
    expect(test.service.reorder('project', [])).toEqual({ kind: 'returned', success: true, data: { parent_id: 'project', changed: 0 } });
    expect(test.getAncestors).not.toHaveBeenCalled();
    expect(test.setStatus).not.toHaveBeenCalled();
    expect(test.notifyCard).not.toHaveBeenCalled();
    expect(test.reorderChildren).toHaveBeenCalledWith('project', []);
  });

  it('propagates exactly once for a real reorder', () => {
    const test = reorderHarness({ ok: true, changed: 2 });
    expect(test.service.reorder('project', [])).toEqual({ kind: 'returned', success: true, data: { parent_id: 'project', changed: 2, propagation: { ok: true } } });
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

  it('leaves a settled parent closed on retained-tombstone identity and reopens/notifies it once on a real reorder', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-analyst-reorder-propagation-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const first = cards.create({ type: 'code', parent: 'project', title: 'first', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      const tombstone = cards.create({ type: 'code', parent: 'project', title: 'retained', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      const second = cards.create({ type: 'code', parent: 'project', title: 'second', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      cards.deleteSubtrees([tombstone.id], () => true, 'analyst');
      cards.setStatus('project', 'running');
      cards.commitActivationOutcome('project', { status: 'done', summary: 'done', result: workflowResult('DONE', 'done') }, '2026-08-15T00:00:00.000Z');
      const notifyCard = jest.fn((cardId: string, notification: { id: string }) => ({ ok: true as const, notificationId: notification.id }));
      const mutations = testAnalystMutationServices(root, cards, notifyCard).cards;
      const versionBeforeIdentity = cards.read('project')!.version_seq;

      expect(mutations.reorder('project', [first.id, second.id])).toEqual({ kind: 'returned', success: true, data: { parent_id: 'project', changed: 0 } });
      expect(cards.read('project')).toMatchObject({ version_seq: versionBeforeIdentity, lifecycle: { status: 'done' } });
      expect(notifyCard).not.toHaveBeenCalled();

      expect(mutations.reorder('project', [second.id, first.id])).toEqual({ kind: 'returned', success: true, data: { parent_id: 'project', changed: 2, propagation: { ok: true } } });
      expect(cards.read('project')).toMatchObject({ lifecycle: { status: 'changed' }, active_child_order: [second.id, first.id, tombstone.id] });
      expect(notifyCard).toHaveBeenCalledTimes(1);
      expect(notifyCard).toHaveBeenCalledWith('project', expect.objectContaining({ source: 'card_changed', content: 'Card changed: analyst reordered children of project' }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('analyst card reopen', () => {
  function settle(cards: CardService, id: string, status: 'done' | 'failed' | 'blocked'): void {
    cards.setStatus(id, 'running');
    if (status === 'done') cards.commitActivationOutcome(id, { status, summary: status, result: workflowResult('DONE', 'done') }, '2026-08-15T00:00:00.000Z');
    else if (status === 'blocked') cards.commitActivationOutcome(id, { status, summary: status, result: workflowResult('BLOCKED', 'blocked') }, '2026-08-15T00:00:00.000Z');
    else cards.commitActivationOutcome(id, { status, summary: status, result: runtimeFailure('failed') }, '2026-08-15T00:00:00.000Z');
  }

  it.each(['done', 'failed', 'blocked'] as const)('reopens a real %s card and returns its current changed view', (status) => {
    const root = mkdtempSync(join(tmpdir(), `saivage-reopen-${status}-`));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const target = cards.create({ type: 'code', parent: 'project', title: status, bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      settle(cards, target.id, status);
      const notifyCard = jest.fn((cardId: string, notification: { id: string }) => ({ ok: true as const, notificationId: notification.id }));
      const outcome = testAnalystMutationServices(root, cards, notifyCard).cards.reopen(target.id);
      expect(outcome).toMatchObject({ kind: 'returned', success: true, data: { card: { id: target.id, lifecycle: { status: 'changed' } }, status: 'changed' } });
      expect(cards.read(target.id)?.lifecycle.status).toBe('changed');
      expect(notifyCard).toHaveBeenCalledTimes(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('propagates through eligible resting ancestors and stops at a running boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-reopen-ancestors-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const goal = cards.create({ type: 'goal', parent: 'project', title: 'Goal', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      const target = cards.create({ type: 'code', parent: goal.id, title: 'Target', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      settle(cards, target.id, 'blocked');
      settle(cards, goal.id, 'failed');
      cards.setStatus('project', 'running');
      const notifyCard = jest.fn((cardId: string, notification: { id: string }) => ({ ok: true as const, notificationId: notification.id }));
      expect(testAnalystMutationServices(root, cards, notifyCard).cards.reopen(target.id)).toMatchObject({ kind: 'returned', success: true });
      expect(cards.read(target.id)?.lifecycle.status).toBe('changed');
      expect(cards.read(goal.id)?.lifecycle.status).toBe('changed');
      expect(cards.read('project')?.lifecycle.status).toBe('running');
      expect(notifyCard.mock.calls.map(([id]) => id)).toEqual([target.id, 'project']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('propagates through every eligible resting ancestor to the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-reopen-all-ancestors-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const goal = cards.create({ type: 'goal', parent: 'project', title: 'Goal', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      const target = cards.create({ type: 'code', parent: goal.id, title: 'Target', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      settle(cards, target.id, 'done');
      settle(cards, goal.id, 'blocked');
      settle(cards, 'project', 'failed');
      expect(testAnalystMutationServices(root, cards, (_id, notification) => ({ ok: true, notificationId: notification.id })).cards.reopen(target.id)).toMatchObject({ kind: 'returned', success: true });
      expect([target.id, goal.id, 'project'].map((id) => cards.read(id)?.lifecycle.status)).toEqual(['changed', 'changed', 'changed']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['backlog', 'running', 'changed', 'stopped', 'cancelled'] as const)('denies non-reopenable status %s without mutation or notification', (status) => {
    const target = card(status);
    const setStatus = jest.fn();
    const notifyCard = jest.fn();
    const outcome = services({ read: jest.fn(() => target), setStatus } as unknown as CardService, notifyCard).cards.reopen(FIRST);
    expect(outcome).toEqual({ kind: 'denied', reason: `card '${FIRST}' is ${status}` });
    expect(setStatus).not.toHaveBeenCalled();
    expect(notifyCard).not.toHaveBeenCalled();
  });

  it('denies a missing target without mutation or notification', () => {
    const setStatus = jest.fn();
    const notifyCard = jest.fn();
    expect(services({ read: jest.fn(() => null), setStatus } as unknown as CardService, notifyCard).cards.reopen(FIRST)).toEqual({ kind: 'denied', reason: `card '${FIRST}' does not exist` });
    expect(setStatus).not.toHaveBeenCalled();
    expect(notifyCard).not.toHaveBeenCalled();
  });

  function failureHarness(setStatusImplementation: (id: string) => void, notifyImplementation: (...args: any[]) => any = () => ({ ok: true })) {
    const states = new Map<string, CardRecord>([[FIRST, card('done')], ['project', card('failed', 'project', 'project')]]);
    const read = jest.fn((id: string) => states.get(id) ?? null);
    const setStatus = jest.fn((id: string) => { setStatusImplementation(id); states.set(id, card('changed', id, id === 'project' ? 'project' : 'code')); });
    const notifyCard = jest.fn(notifyImplementation);
    const store = { read, getAncestors: jest.fn(() => ['project']), setStatus, listChildren: jest.fn((id: string) => id === 'project' ? [FIRST] : []) } as unknown as CardService;
    return { service: services(store, notifyCard).cards, read, setStatus, notifyCard };
  }

  it('lets a known target status failure escape before notification or a success reread', () => {
    const failure = new Error('target status failed');
    const test = failureHarness((id) => { if (id === FIRST) throw failure; });
    expect(() => test.service.reopen(FIRST)).toThrow(failure);
    expect(test.read.mock.calls.map(([id]) => id)).toEqual([FIRST, FIRST, FIRST]);
    expect(test.notifyCard).not.toHaveBeenCalled();
  });

  it('lets a known ancestor status failure escape after the target attempt without a success reread', () => {
    const failure = new Error('ancestor status failed');
    const test = failureHarness((id) => { if (id === 'project') throw failure; });
    expect(() => test.service.reopen(FIRST)).toThrow(failure);
    expect(test.setStatus.mock.calls.map(([id]) => id)).toEqual([FIRST, 'project']);
    expect(test.read.mock.calls.map(([id]) => id)).toEqual([FIRST, FIRST, FIRST, 'project']);
    expect(test.notifyCard).not.toHaveBeenCalled();
  });

  it('suppresses only an ordinary notification error after complete propagation and returns the fresh view', () => {
    const test = failureHarness(() => undefined, () => { throw new Error('notification failed'); });
    expect(test.service.reopen(FIRST)).toMatchObject({ kind: 'returned', success: true, data: { card: { id: FIRST, lifecycle: { status: 'changed' } }, status: 'changed' } });
    expect(test.setStatus.mock.calls.map(([id]) => id)).toEqual([FIRST, 'project']);
    expect(test.read.mock.calls.map(([id]) => id)).toEqual([FIRST, FIRST, FIRST, 'project', FIRST]);
  });

  it.each([FIRST, 'project'])('rethrows publication uncertainty from %s status without notification or success reread', (failedId) => {
    const failure = new PublicationOutcomeUnknownError();
    const test = failureHarness((id) => { if (id === failedId) throw failure; });
    expect(() => test.service.reopen(FIRST)).toThrow(failure);
    expect(test.notifyCard).not.toHaveBeenCalled();
    expect(test.read.mock.calls.map(([id]) => id)).toEqual(failedId === FIRST ? [FIRST, FIRST, FIRST] : [FIRST, FIRST, FIRST, 'project']);
  });

  it('rethrows notification publication uncertainty without a success reread', () => {
    const failure = new PublicationOutcomeUnknownError();
    const test = failureHarness(() => undefined, () => { throw failure; });
    expect(() => test.service.reopen(FIRST)).toThrow(failure);
    expect(test.setStatus).toHaveBeenCalledTimes(2);
    expect(test.read.mock.calls.map(([id]) => id)).toEqual([FIRST, FIRST, FIRST, 'project']);
  });
});

describe('Analyst record publication', () => {
  it('accepts directly once and returns reusable current and immutable accepted URLs', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-analyst-record-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const target = cards.create({ type: 'code', parent: 'project', title: 'Target', bootstrap_content: '# Goal\nOriginal\n# Instructions\nOriginal\n# Acceptance Criteria\nOriginal', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      const finalContent = '# Goal\nFinal\n# Instructions\nFinal\n# Acceptance Criteria\nFinal';
      const result = testAnalystMutationServices(root, cards, (_cardId, notification) => ({ ok: true, notificationId: notification.id })).recordMutations.edit(`record:///brief.md?card=${target.id}`, 'Original', 'Final', true);
      expect(result).toMatchObject({ kind: 'returned', success: true, data: { card_id: target.id, name: 'brief.md', state: 'closed', revision: 2, current_url: `record:///brief.md?card=${target.id}`, accepted_version_url: `record:///brief.md?card=${target.id}&v=2`, bytes: Buffer.byteLength(finalContent), written: true, surface: 'analyst', propagation: { ok: true } } });
      expect(current(cards,target.id,'brief.md').accepted?.content).toBe(finalContent);
      expect(historical(cards,target.id,'brief.md',2).artifact.accepted.content).toBe(finalContent);
      expect(cards.readRecordVersion(target.id,'brief.md',3)).toEqual({kind:'version-not-found',version:3});
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns open-conflict failures without publishing', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-analyst-record-failures-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const target = cards.create({ type: 'code', parent: 'project', title: 'Target', bootstrap_content: 'Original', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      const service = testAnalystMutationServices(root, cards, (_cardId, notification) => ({ ok: true, notificationId: notification.id })).recordMutations;
      const open = cards.openRecord(target.id, 'brief.md');
      expect(service.write(`record:///brief.md?card=${target.id}`, 'New')).toMatchObject({ success: false, data: { code: 'record_open_conflict', current_head: open.revision } });
      expect(current(cards,target.id,'brief.md').revision).toBe(open.revision);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('other Analyst mutation facets', () => {
  it('projects a directly viewed queued inactive card without exposing its delivery queue', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-queued-card-view-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const target = cards.create({ type: 'code', parent: 'project', title: 'Queued', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      cards.enqueueNotification(target.id, { id: '11111111-1111-4111-8111-111111111111', content: 'private direct body', created_at: '2026-09-09T00:00:00.000Z' });
      const view = cardViewSchema.parse(toCardView(cards, cards.read(target.id)!));
      expect(view.card).not.toHaveProperty('pending_notifications');
      expect(JSON.stringify(view)).not.toMatch(/private-direct-id|private direct body/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('calls the configuration authority exactly once through apply', () => {
    const applyChange = jest.fn(() => ({ success: true, requires_restart: true }));
    const bundle = createAnalystMutationServices({ store: {} as CardService, configAuthority: { applyChange } as never, notifyCard: jest.fn((_id, notification: { id: string }) => ({ ok: true as const, notificationId: notification.id })), submitNotification: jest.fn() as never, cancelCard: jest.fn() as never });
    expect(bundle.config.apply({ kind: 'set_server_setting', key: 'host', value: '127.0.0.1' })).toMatchObject({ kind: 'returned', success: true });
    expect(applyChange).toHaveBeenCalledTimes(1);
  });

  it('relies on the notification owner result without a separate card read', async () => {
    const read = jest.fn();
    const submitNotification = jest.fn<NotificationSubmissionPort>(async (cardId, notification) => ({ queued: true, cardId, notificationId: notification.id, interruption: { status: 'not_requested' } }));
    const bundle = services({ read } as unknown as CardService, undefined, undefined, submitNotification);
    const signal = new AbortController().signal;
    const before = Date.now();
    await expect(bundle.notifications.queue(FIRST, 'context', 'body', 'normal', signal)).resolves.toMatchObject({ kind: 'returned', success: true });
    expect(read).not.toHaveBeenCalled();
    expect(submitNotification).toHaveBeenCalledTimes(1);
    expect(submitNotification).toHaveBeenCalledWith(FIRST, {
      id: expect.stringMatching(/^[a-f0-9-]{36}$/),
      content: 'body',
      source: 'context',
      created_at: expect.any(String),
    }, 'normal', signal);
    const notification = submitNotification.mock.calls[0]![1];
    expect(Date.parse(notification.created_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(notification.created_at)).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    {
      result: { queued: true as const, cardId: FIRST, notificationId: '00000000-0000-4000-8000-000000000001', interruption: { status: 'not_requested' as const } },
      expected: { kind: 'returned', success: true, data: { queued: true, card_id: FIRST, notification_id: '00000000-0000-4000-8000-000000000001', body: 'body', interruption: { status: 'not_requested' } } },
    },
    {
      result: { queued: false as const, reason: 'missing_card' as const, cardId: FIRST },
      expected: { kind: 'returned', success: false, error: `Card '${FIRST}' not found.`, data: { queued: false, reason: 'missing_card', card_id: FIRST } },
    },
    {
      result: { queued: false as const, reason: 'terminal_card' as const, cardId: FIRST, status: 'done' as const },
      expected: { kind: 'returned', success: false, error: `Cannot queue notification for terminal card '${FIRST}' in status 'done'.`, data: { queued: false, reason: 'terminal_card', card_id: FIRST, status: 'done' } },
    },
    {
      result: { queued: false as const, reason: 'activation_closed' as const, cardId: FIRST },
      expected: { kind: 'returned', success: false, error: `Cannot queue notification for card '${FIRST}': its current activation is closed to new notifications.`, data: { queued: false, reason: 'activation_closed', card_id: FIRST } },
    },
  ])('maps notification owner result $result exactly', async ({ result, expected }) => {
    const outcome = await services({ read: jest.fn() } as unknown as CardService, undefined, undefined, () => result).notifications.queue(FIRST, 'context', 'body', 'normal');
    expect(outcome).toEqual(expected);
    if (!result.queued && result.reason === 'activation_closed') expect(JSON.stringify(outcome)).not.toMatch(/status|winner/);
  });

  it('projects queued blocked cards through the strict queue-free CardView boundary on reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-reopen-queued-view-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const target = cards.create({ type: 'code', parent: 'project', title: 'Queued blocked', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      cards.setStatus(target.id, 'running');
      cards.commitActivationOutcome(target.id, { status: 'blocked', summary: 'blocked', result: workflowResult('BLOCKED', 'blocked') }, '2026-09-09T00:00:00.000Z');
      cards.enqueueNotification(target.id, { id: '11111111-1111-4111-8111-111111111111', content: 'private body', created_at: '2026-09-09T00:00:01.000Z' });
      const outcome = testAnalystMutationServices(root, cards, (_id, notification) => ({ ok: true, notificationId: notification.id })).cards.reopen(target.id);
      if (outcome.kind !== 'returned' || !outcome.success) throw new Error('Expected successful reopen.');
      const view = cardViewSchema.parse(outcome.data);
      expect(view.card).not.toHaveProperty('pending_notifications');
      expect(cards.read(target.id)?.pending_notifications).toEqual(['11111111-1111-4111-8111-111111111111']);
      expect(cards.readPendingNotifications(target.id)).toEqual([expect.objectContaining({ id: '11111111-1111-4111-8111-111111111111', content: 'private body' })]);
      expect(() => cardViewSchema.parse({ ...view, card: { ...view.card, pending_notifications: [] } })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('edits from the fresh latest closed brief', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-fresh-brief-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const card = cards.create({ type: 'code', parent: 'project', title: 'Fresh brief', bootstrap_content: '# Goal\nOld\n# Instructions\nOld\n# Acceptance Criteria\nOld', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      const open = cards.openRecord(card.id, 'brief.md');
      const edited = cards.editRecord(card.id, 'brief.md', '# Goal\nFresh current\n# Instructions\nFresh current\n# Acceptance Criteria\nFresh current');
      const closed = cards.closeRecord(card.id, 'brief.md', 'analyst');
      const service = testAnalystMutationServices(root, cards, (_cardId, notification) => ({ ok: true, notificationId: notification.id })).recordMutations;
      expect(service.edit(`record:///brief.md?card=${card.id}`, 'Fresh current', 'Newest', true)).toMatchObject({ kind: 'returned', success: true });
      expect(current(cards,card.id,'brief.md').accepted?.content).toContain('Newest');
      expect(current(cards,card.id,'brief.md').accepted?.content).not.toContain('Fresh current');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('applies exact full and unique-terminal edits, denies invalid replacements, and reopens failed cards as changed', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-stale-safe-brief-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const initial = '# Goal\nOld\n# Instructions\nKeep\n# Acceptance Criteria\nTerminal';
      const child = cards.create({ type: 'code', parent: 'project', title: 'Recovery edit', bootstrap_content: initial, priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      cards.setStatus(child.id, 'running');
      cards.commitActivationOutcome(child.id, { status: 'failed', summary: 'failed', result: runtimeFailure('failed') }, '2026-08-10T00:00:00.000Z');
      const service = testAnalystMutationServices(root, cards, (_cardId, notification) => ({ ok: true, notificationId: notification.id })).recordMutations;
      const target = `record:///brief.md?card=${child.id}`;

      const fullReplacement = `${initial}\nRecovery note.`;
      expect(service.edit(target, initial, fullReplacement, false)).toMatchObject({ kind: 'returned', success: true, data: { card_id: child.id, name: 'brief.md', bytes: Buffer.byteLength(fullReplacement), written: true, propagation: { ok: true } } });
      expect(cards.read(child.id)!.lifecycle.status).toBe('changed');
      expect(current(cards,child.id,'brief.md').accepted?.content).toBe(fullReplacement);

      const terminalCard = cards.create({ type: 'code', parent: 'project', title: 'Terminal edit', bootstrap_content: initial, priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
      const terminalTarget = `record:///brief.md?card=${terminalCard.id}`;
      const terminalReplacement = 'Recovery note.\nSecond note.';
      expect(service.edit(terminalTarget, 'Terminal', terminalReplacement, false)).toMatchObject({ kind: 'returned', success: true, data: { propagation: { ok: true } } });
      const settled = current(cards,terminalCard.id,'brief.md').accepted?.content;
      expect(settled?.endsWith(terminalReplacement)).toBe(true);

      const freshTarget = `record:///brief.md?card=${terminalCard.id}`;
      expect(service.edit(freshTarget, 'stale missing value', 'no', false)).toMatchObject({ kind: 'returned', success: false, data: { code: 'record_edit_old_string_not_found' } });
      expect(current(cards,terminalCard.id,'brief.md').accepted?.content).toBe(settled);
      expect(service.edit(freshTarget, '#', 'changed', false)).toMatchObject({ kind: 'returned', success: false, data: { code: 'record_edit_old_string_multiple_matches' } });
      expect(current(cards,terminalCard.id,'brief.md').accepted?.content).toBe(settled);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('classifies strict current read failures as restart-required without publication', () => {
    const targetCard = card('backlog');
    const openRecord = jest.fn();
    const store = { read: () => targetCard, workflows: TEST_WORKFLOWS, classifyCurrentRecord: () => { throw new Error('HOSTILE_STRICT_READ'); }, openRecord } as unknown as CardService;
    expect(services(store).recordMutations.write(`record:///brief.md?card=${FIRST}`, 'New')).toMatchObject({ kind: 'returned', success: false, data: { code: 'current_state_unavailable', restart_required: true } });
    expect(openRecord).not.toHaveBeenCalled();
  });
});
