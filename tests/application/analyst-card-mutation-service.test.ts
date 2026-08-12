import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAnalystMutationServices } from '../../src/application/analyst-mutation-services.js';
import { CardService } from '../helpers/canonical-project.js';
import type { CardRecord, CardStatus, CardType } from '../../src/schemas/index.js';
import { initProjectTree, testAnalystMutationServices, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { runtimeFailure, workflowResult } from '../helpers/workflow-result.js';

const FIRST = 'card-a';
const SECOND = 'card-a-b';

function card(status: CardStatus, id = FIRST, type: CardType = 'code'): CardRecord {
  const common = { id, type, children: [], title: id, subtype: null, tags: [], priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, created_at: '2026-07-20T00:00:00.000Z', updated_at: '2026-07-20T00:00:00.000Z', version_seq: 1, assigned_to: null, depends_on: [], related: [], metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null, pending_notifications: [] };
  switch (status) {
    case 'done': return { ...common, lifecycle: { status, result: workflowResult('DONE', 'done'), error: null, completed_at: '2026-07-20T00:00:00.000Z' } };
    case 'failed': return { ...common, lifecycle: { status, result: runtimeFailure('failed'), error: 'failed', completed_at: '2026-07-20T00:00:00.000Z' } };
    case 'blocked': return { ...common, lifecycle: { status, result: workflowResult('BLOCKED', 'blocked'), error: 'blocked', completed_at: null } };
    default: return { ...common, lifecycle: { status, result: null, error: null, completed_at: null } };
  }
}

function services(store: CardService, notifyCard = jest.fn(() => ({ ok: true as const, notificationId: 'notification' })), cancelCard = jest.fn(async () => ({ card_id: FIRST, status: 'cancelled' as const, cancelled_card_ids: [FIRST] }))) {
  if (!('workflows' in store)) Object.assign(store, { workflows: TEST_WORKFLOWS });
  return createAnalystMutationServices({ projectRoot: '/tmp/analyst-mutation-test', store, configAuthority: { applyChange: jest.fn() } as never, notifyCard, cancelCard });
}

describe('analyst card mutation service deletion', () => {
  it('delegates the complete requested root set to one atomic service preflight and returns deterministic deletion data', () => {
    const deleteSubtrees = jest.fn((ids: readonly string[], allowed: (card: CardRecord) => boolean) => {
      expect(ids).toEqual([FIRST, SECOND, FIRST]);
      expect(allowed(card('backlog'))).toBe(true);
      expect(allowed(card('running'))).toBe(false);
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
    const stopped = card('stopped', FIRST, 'goal');
    const child = card('backlog', SECOND);
    const store = {
      read: jest.fn((id: string) => id === FIRST ? stopped : null),
      getDescendantIds: jest.fn(() => []),
      listChildren: jest.fn((id: string) => id === 'project' ? [FIRST] : id === FIRST ? [SECOND] : []), create: jest.fn(() => child),
    } as unknown as CardService;
    const bundle = services(store);
    expect(bundle.cards.create({ type: 'code', parent: FIRST, title: 'child', bootstrap_content: 'brief' })).toMatchObject({ kind: 'returned', success: true });
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
      const card = cards.create({ type: 'code', parent: 'project', title: 'Stopped work', bootstrap_content: '# Goal\nOld\n# Instructions\nOld\n# Acceptance Criteria\nOld', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      cards.setStatus(card.id, 'running');
      cards.stopRunningForRecovery(card.id);
      const service = testAnalystMutationServices(root, cards, () => ({ ok: true, notificationId: 'n' })).recordMutations;

      expect(service.write(`record:///brief.md?card=${card.id}&expected_head=1`, '# Goal\nNew\n# Instructions\nNew\n# Acceptance Criteria\nNew')).toMatchObject({ success: true });
      expect(cards.read(card.id)).toMatchObject({ lifecycle: { status: 'stopped' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('analyst child reorder propagation', () => {
  function reorderHarness(result: ReturnType<CardService['reorderChildren']>) {
    const parent = card('backlog', 'project', 'project');
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
    expect(test.reorderChildren).toHaveBeenCalledWith('project', []);
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

describe('Analyst record publication', () => {
  it('publishes open, edit, and close versions and returns the next optimistic URL', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-analyst-record-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const target = cards.create({ type: 'code', parent: 'project', title: 'Target', bootstrap_content: '# Goal\nOriginal\n# Instructions\nOriginal\n# Acceptance Criteria\nOriginal', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      const finalContent = '# Goal\nFinal\n# Instructions\nFinal\n# Acceptance Criteria\nFinal';
      const result = testAnalystMutationServices(root, cards).recordMutations.edit(`record:///brief.md?card=${target.id}&expected_head=1`, 'Original', 'Final', true);
      expect(result).toMatchObject({ kind: 'returned', success: true, data: { card_id: target.id, name: 'brief.md', state: 'closed', head_version: 4, current_url: `record:///brief.md?card=${target.id}`, version_url: `record:///brief.md?card=${target.id}&v=4`, mutation_url: `record:///brief.md?card=${target.id}&expected_head=4`, bytes: Buffer.byteLength(finalContent), written: true, surface: 'analyst', propagation: { ok: true } } });
      expect(cards.readCurrentRecord(target.id, 'brief.md').artifact.accepted?.content).toBe(finalContent);
      expect(cards.readHistoricalRecord(target.id, 'brief.md', 2).artifact.state).toBe('open');
      expect(cards.readHistoricalRecord(target.id, 'brief.md', 3).artifact.draft?.content).toBe(finalContent);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns stale and open-conflict failures without publishing', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-analyst-record-failures-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const target = cards.create({ type: 'code', parent: 'project', title: 'Target', bootstrap_content: 'Original', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      const service = testAnalystMutationServices(root, cards).recordMutations;
      expect(service.write(`record:///brief.md?card=${target.id}&expected_head=2`, 'New')).toMatchObject({ success: false, data: { code: 'record_mutation_stale', current_head: 1 } });
      const open = cards.openRecord(target.id, 'brief.md', 1);
      expect(service.write(`record:///brief.md?card=${target.id}&expected_head=${open.headVersion}`, 'New')).toMatchObject({ success: false, data: { code: 'record_open_conflict', current_head: open.headVersion } });
      expect(cards.readCurrentRecord(target.id, 'brief.md').headVersion).toBe(open.headVersion);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('other Analyst mutation facets', () => {
  it('calls the configuration authority exactly once through apply', () => {
    const applyChange = jest.fn(() => ({ success: true, requires_restart: true }));
    const bundle = createAnalystMutationServices({ projectRoot: '/tmp/config-test', store: {} as CardService, configAuthority: { applyChange } as never, cancelCard: jest.fn() as never });
    expect(bundle.config.apply({ kind: 'set_server_setting', key: 'host', value: '127.0.0.1' })).toMatchObject({ kind: 'returned', success: true });
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
      const card = cards.create({ type: 'code', parent: 'project', title: 'Fresh brief', bootstrap_content: '# Goal\nOld\n# Instructions\nOld\n# Acceptance Criteria\nOld', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      const open = cards.openRecord(card.id, 'brief.md', 1);
      const edited = cards.editRecord(card.id, 'brief.md', open.headVersion, '# Goal\nFresh current\n# Instructions\nFresh current\n# Acceptance Criteria\nFresh current');
      const closed = cards.closeRecord(card.id, 'brief.md', edited.headVersion, 'analyst', card.version_seq);
      const service = testAnalystMutationServices(root, cards).recordMutations;
      expect(service.edit(`record:///brief.md?card=${card.id}&expected_head=${closed.headVersion}`, 'Fresh current', 'Newest', true)).toMatchObject({ kind: 'returned', success: true });
      expect(cards.readCurrentRecord(card.id, 'brief.md').artifact.accepted?.content).toContain('Newest');
      expect(cards.readCurrentRecord(card.id, 'brief.md').artifact.accepted?.content).not.toContain('Fresh current');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('applies exact full and unique-terminal stale-safe edits, denies stale/non-unique values, and reopens failed cards as changed', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-stale-safe-brief-'));
    try {
      initProjectTree(root);
      const cards = new CardService(root);
      const initial = '# Goal\nOld\n# Instructions\nKeep\n# Acceptance Criteria\nTerminal';
      const child = cards.create({ type: 'code', parent: 'project', title: 'Recovery edit', bootstrap_content: initial, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      cards.setStatus(child.id, 'running');
      cards.commitActivationOutcome(child.id, { status: 'failed', summary: 'failed', result: runtimeFailure('failed') }, '2026-08-10T00:00:00.000Z');
      const service = testAnalystMutationServices(root, cards).recordMutations;
      const target = `record:///brief.md?card=${child.id}&expected_head=1`;

      const fullReplacement = `${initial}\nRecovery note.`;
      expect(service.edit(target, initial, fullReplacement, false)).toMatchObject({ kind: 'returned', success: true, data: { card_id: child.id, name: 'brief.md', bytes: Buffer.byteLength(fullReplacement), written: true, propagation: { ok: true } } });
      expect(cards.read(child.id)!.lifecycle.status).toBe('changed');
      expect(cards.readCurrentRecord(child.id, 'brief.md').artifact.accepted?.content).toBe(fullReplacement);

      const terminalCard = cards.create({ type: 'code', parent: 'project', title: 'Terminal edit', bootstrap_content: initial, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      const terminalTarget = `record:///brief.md?card=${terminalCard.id}&expected_head=1`;
      const terminalReplacement = 'Recovery note.\nSecond note.';
      expect(service.edit(terminalTarget, 'Terminal', terminalReplacement, false)).toMatchObject({ kind: 'returned', success: true, data: { propagation: { ok: true } } });
      const settled = cards.readCurrentRecord(terminalCard.id, 'brief.md').artifact.accepted?.content;
      expect(settled?.endsWith(terminalReplacement)).toBe(true);

      const freshTarget = `record:///brief.md?card=${terminalCard.id}&expected_head=4`;
      expect(service.edit(freshTarget, 'stale missing value', 'no', false)).toMatchObject({ kind: 'returned', success: false, data: { code: 'record_edit_old_string_not_found' } });
      expect(cards.readCurrentRecord(terminalCard.id, 'brief.md').artifact.accepted?.content).toBe(settled);
      expect(service.edit(freshTarget, '#', 'changed', false)).toMatchObject({ kind: 'returned', success: false, data: { code: 'record_edit_old_string_multiple_matches' } });
      expect(cards.readCurrentRecord(terminalCard.id, 'brief.md').artifact.accepted?.content).toBe(settled);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('classifies strict current read failures as restart-required without publication', () => {
    const targetCard = card('backlog');
    const openRecord = jest.fn();
    const store = { read: () => targetCard, workflows: TEST_WORKFLOWS, recordReader: { definition: () => ({ filename: 'brief.md', format: 'markdown', schema: 'card-brief.v1', bootstrap: true, writers: ['analyst'] }) }, readCurrentRecordOrNull: () => { throw new Error('HOSTILE_STRICT_READ'); }, openRecord } as unknown as CardService;
    expect(services(store).recordMutations.write(`record:///brief.md?card=${FIRST}&expected_head=1`, 'New')).toMatchObject({ kind: 'returned', success: false, data: { code: 'current_state_unavailable', restart_required: true } });
    expect(openRecord).not.toHaveBeenCalled();
  });
});
