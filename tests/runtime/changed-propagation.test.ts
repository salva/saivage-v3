import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { workflowResult } from '../helpers/workflow-result.js';
import { propagateAnalystRecordEdit } from '../../src/runtime/changed-propagation.js';
import { uuidV4Schema } from '../../src/schemas/index.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'record-changed-propagation-')); roots.push(root);
  initProjectTree(root);
  return new CardService(root);
}
function child(cards: CardService, parent: string, type = 'goal') {
  return cards.create({ parent, type, title: 'Fixture', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
}
function rest(cards: CardService, id: string, status: 'blocked' | 'done' | 'failed') {
  cards.setStatus(id, 'running');
  cards.commitActivationOutcome(id, { status, summary: status, result: workflowResult(status.toUpperCase() as 'BLOCKED' | 'DONE' | 'FAILED', status) }, '2026-10-02T00:00:00.000Z');
}
const origin = { kind: 'analyst_edit' as const, summary: 'Correction' };

describe('Analyst record changed propagation', () => {
  it('preserves a changed leaf and reopens only resting ancestors, with fresh notices on every correction', () => {
    const cards = setup();
    const done = child(cards, 'project');
    const blocked = child(cards, done);
    const failed = child(cards, blocked);
    const target = child(cards, failed, 'code');
    rest(cards, target, 'blocked'); cards.setStatus(target, 'changed');
    rest(cards, 'project', 'blocked'); cards.setStatus('project', 'changed');
    rest(cards, done, 'done'); rest(cards, blocked, 'blocked'); rest(cards, failed, 'failed');
    const versions = [target, 'project'].map((id) => cards.read(id)!.version_seq);
    const notify = jest.fn((_id: string, notice: Parameters<CardService['enqueueNotification']>[1]) => ({ ok: true as const, notificationId: notice.id }));
    expect(propagateAnalystRecordEdit(cards, target, origin, notify).flipped).toEqual([
      { card_id: failed, previous_status: 'failed' }, { card_id: blocked, previous_status: 'blocked' }, { card_id: done, previous_status: 'done' },
    ]);
    const afterFirst = [target, failed, blocked, done, 'project'].map((id) => cards.read(id)!);
    expect(afterFirst.map((card) => card.lifecycle.status)).toEqual(Array(5).fill('changed'));
    expect([cards.read(target)!.version_seq, cards.read('project')!.version_seq]).toEqual(versions);
    expect(propagateAnalystRecordEdit(cards, target, origin, notify).flipped).toEqual([]);
    expect([target, failed, blocked, done, 'project'].map((id) => cards.read(id))).toEqual(afterFirst);
    expect(notify.mock.calls.map(([id]) => id)).toEqual([target, failed, blocked, done, 'project', target, failed, blocked, done, 'project']);
    expect(new Set(notify.mock.calls.map(([, notice]) => notice.id)).size).toBe(10);
    for (const [, notice] of notify.mock.calls) {
      expect(uuidV4Schema.parse(notice.id)).toBe(notice.id);
      expect(notice).toMatchObject({ content: 'Card changed: Correction', source: 'card_changed', created_at: expect.any(String) });
    }
  });

  it('publishes distinct correction notices for successive propagation calls without re-transitioning a changed target', () => {
    const cards = setup();
    const target = child(cards, 'project', 'code');
    rest(cards, target, 'blocked');
    cards.setStatus(target, 'changed');
    const before = cards.read(target)!;
    const notify = jest.fn((id: string, notice: Parameters<CardService['enqueueNotification']>[1]) => {
      cards.enqueueNotification(id, notice);
      return { ok: true as const, notificationId: notice.id };
    });
    const correction = { kind: 'analyst_correction' as const, issues: [{ summary: 'Recheck evidence', severity: 'warning' as const }] };
    expect(propagateAnalystRecordEdit(cards, target, correction, notify).flipped).toEqual([]);
    expect(propagateAnalystRecordEdit(cards, target, correction, notify).flipped).toEqual([]);
    const after = cards.read(target)!;
    expect(after.lifecycle).toEqual(before.lifecycle);
    expect(after.version_seq).toBe(before.version_seq + 2);
    const notices = notify.mock.calls.filter(([id]) => id === target).map(([, notice]) => notice);
    expect(notices).toHaveLength(2);
    expect(notices[0]!.id).not.toBe(notices[1]!.id);
    for (const notice of notices) {
      expect(uuidV4Schema.parse(notice.id)).toBe(notice.id);
      expect(notice).toMatchObject({ content: 'Card changed: Recheck evidence', source: 'analyst_correction' });
    }
    expect(after.pending_notifications).toEqual(notices.map(notice => notice.id));
    expect(cards.readPendingNotifications(target)).toEqual(notices);
  });

  it('includes the first running child-capable ancestor and does not touch or notify anything above it', () => {
    const cards = setup(); const running = child(cards, 'project'); const resting = child(cards, running); const target = child(cards, resting, 'code');
    rest(cards, target, 'blocked'); cards.setStatus(target, 'changed'); rest(cards, resting, 'blocked'); cards.setStatus(running, 'running'); rest(cards, 'project', 'done');
    const rootBefore = cards.read('project'); const runningBefore = cards.read(running);
    const notify = jest.fn((_id: string, notice: Parameters<CardService['enqueueNotification']>[1]) => ({ ok: true as const, notificationId: notice.id }));
    expect(propagateAnalystRecordEdit(cards, target, origin, notify).flipped).toEqual([{ card_id: resting, previous_status: 'blocked' }]);
    expect(notify.mock.calls.map(([id]) => id)).toEqual([target, resting, running]);
    expect(cards.read('project')).toEqual(rootBefore); expect(cards.read(running)).toEqual(runningBefore);
  });

  it('notifies only a changed root without another lifecycle version', () => {
    const cards = setup(); rest(cards, 'project', 'blocked'); cards.setStatus('project', 'changed'); const before = cards.read('project');
    const notify = jest.fn((_id: string, notice: Parameters<CardService['enqueueNotification']>[1]) => ({ ok: true as const, notificationId: notice.id }));
    expect(propagateAnalystRecordEdit(cards, 'project', origin, notify)).toEqual({ flipped: [] });
    expect(notify.mock.calls.map(([id]) => id)).toEqual(['project']); expect(cards.read('project')).toEqual(before);
  });
});
