import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../helpers/canonical-project.js';
import type { CardActivationOutcome } from '../../src/contracts/tool-api.js';
import { readCardArtifacts } from '../../src/persistence/card-files.js';
import { readCanonicalGrowingFile } from '../../src/persistence/growing-file.js';
import { cardStreamRowSchema } from '../../src/persistence/canonical-card-artifacts.js';
import { cardStreamFile } from '../../src/persistence/layout.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { runtimeFailure, workflowResult } from '../helpers/workflow-result.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function setup() { const root = mkdtempSync(join(tmpdir(), 'card-contract-')); roots.push(root); initProjectTree(root); return { root, cards: new CardService(root) }; }
function input(parent = 'project', title = 'child', created_by: 'analyst' | 'planner' = 'analyst', depends_on: string[] = []) { return { type: 'code' as const, parent, title, bootstrap_content: `${title} brief`, tags: [], priority: 0, urgency: 'normal' as const, created_by, depends_on, related: [] }; }
function history(root: string, id: string) { return readCardArtifacts(root, id).artifacts.at(-1)!.history!; }
function versionCount(root: string, id: string) { return readCardArtifacts(root, id).artifacts.length; }
const settled = '2026-07-22T00:00:00.000Z';
type TerminalOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;
const done = (summary = 'done'): Extract<TerminalOutcome, { status: 'done' }> => ({ status: 'done', summary, result: workflowResult('DONE', summary) });
const failed = (summary = 'failed'): Extract<TerminalOutcome, { status: 'failed' }> => ({ status: 'failed', summary, result: runtimeFailure(summary) });
const blocked = (summary = 'blocked'): Extract<TerminalOutcome, { status: 'blocked' }> => ({ status: 'blocked', summary, result: workflowResult('BLOCKED', summary) });
const terminalFactories = [done, failed, blocked] as const;

function createInStatus(cards: CardService, status: 'backlog' | 'running' | 'changed' | 'stopped' | 'done' | 'failed' | 'blocked' | 'cancelled', title: string) {
  const card = cards.create(input('project', title));
  if (status === 'backlog') return card;
  if (status === 'cancelled') return cards.setStatus(card.id, 'cancelled');
  cards.setStatus(card.id, 'running');
  if (status === 'running') return cards.read(card.id)!;
  if (status === 'stopped') return cards.stopRunningForRecovery(card.id);
  const outcome = status === 'done' || status === 'changed' ? done(title) : status === 'failed' ? failed(title) : blocked(title);
  cards.commitActivationOutcome(card.id, outcome, settled);
  return status === 'changed' ? cards.setStatus(card.id, 'changed') : cards.read(card.id)!;
}

describe('exact card producer contracts', () => {
  it('publishes complete exact initial root and child records and runtime-owned child links', () => {
    const { root, cards } = setup(); const child = cards.create(input('project', 'child', 'planner'));
    const project = readCardArtifacts(root, 'project').artifacts[0];
    if (project?.kind !== 'card-version') throw new Error('Expected initial project row.');
    expect(project).toMatchObject({ format_version: 2, card_id: 'project', version: 1, history: null, card: {
      id: 'project', type: 'project', children: [], tags: [], priority: 0, urgency: 'normal', created_by: 'runtime:bootstrap', version_seq: 1,
      subtype: null, assigned_to: null, depends_on: [], related: [], metrics: null, estimate: null, started_at: null, duration_ms: null,
      status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null,
      pending_notifications: [], lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    } });
    expect(project.card.created_at).toBe(project.card.updated_at);
    expect(Object.keys(child).sort()).toEqual(['assigned_to','children','created_at','created_by','depends_on','duration_ms','estimate','id','latest_self_report','lifecycle','metadata','metrics','pending_notifications','priority','related','started_at','status_text','status_text_author_session_id','status_text_updated_at','subtype','tags','title','type','updated_at','urgency','version_seq'].sort());
    expect(child).toMatchObject({ type: 'code', children: [], created_by: 'planner', depends_on: [], related: [], subtype: null, assigned_to: null, metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null, pending_notifications: [], lifecycle: { status: 'backlog', result: null, error: null, completed_at: null } });
    expect(child.created_at).toBe(child.updated_at);
    expect(history(root, 'project')).toMatchObject({ kind: 'child_link', changed_by_actor: 'runtime', changed_by_surface: 'runtime', change_reason: 'child linked', changed_fields: ['children'], change_summary: `linked child ${child.id}` });
    const analystChild = cards.create(input('project', 'analyst child', 'analyst'));
    expect(analystChild.created_by).toBe('analyst');
    expect(history(root, 'project')).toMatchObject({ kind: 'child_link', changed_by_actor: 'runtime', changed_by_surface: 'runtime', change_summary: `linked child ${analystChild.id}` });
  });

  it('admits edits only from backlog, changed, or stopped and rejects even no-op edits in every other state', () => {
    const { root, cards } = setup();
    for (const status of ['backlog', 'changed', 'stopped'] as const) {
      const card = createInStatus(cards, status, `editable ${status}`);
      const before = versionCount(root, card.id);
      expect(cards.editCard(card.id, {}).version_seq).toBe(card.version_seq);
      expect(cards.editCard(card.id, { title: card.title }).version_seq).toBe(card.version_seq);
      expect(versionCount(root, card.id)).toBe(before);
      cards.editCard(card.id, { title: `${status} edited`, tags: ['x'], priority: 2, urgency: 'high', related: ['project'] });
      expect(history(root, card.id)).toMatchObject({ kind: 'update', changed_by_actor: 'planner', changed_by_surface: 'runtime', change_reason: 'agent edit_card', changed_fields: ['title', 'tags', 'priority', 'urgency', 'related'], change_summary: 'title, tags, priority, urgency, related updated' });
    }
    for (const status of ['running', 'done', 'failed', 'blocked', 'cancelled'] as const) {
      for (const patchKind of ['empty', 'equal', 'different'] as const) {
        const card = createInStatus(cards, status, `${status}-${patchKind}`);
        const patch = patchKind === 'empty' ? {} : { title: patchKind === 'equal' ? card.title : `different ${status}` };
        const before = versionCount(root, card.id);
        expect(() => cards.editCard(card.id, patch)).toThrow(/cannot be edited/);
        expect(versionCount(root, card.id)).toBe(before);
      }
    }
  });

  it('owns every admitted generic status source/target pair and rejects every removed edge without append', () => {
    const { root, cards } = setup();
    const admitted = {
      running: ['backlog', 'blocked', 'changed'],
      changed: ['blocked', 'done', 'failed'],
      cancelled: ['backlog', 'running', 'blocked', 'changed', 'stopped', 'failed'],
    } as const;
    for (const [target, sources] of Object.entries(admitted) as Array<[keyof typeof admitted, readonly (keyof typeof admitted | 'backlog' | 'blocked' | 'done' | 'failed' | 'stopped')[]]>) {
      for (const source of sources) {
        const card = createInStatus(cards, source, `${source}-to-${target}`);
        const committed = cards.setStatus(card.id, target);
        expect(committed.lifecycle).toEqual({ status: target, result: null, error: null, completed_at: null });
        expect(history(root, card.id)).toMatchObject({ kind: 'status', changed_by_actor: 'runtime', changed_by_surface: 'runtime', change_reason: `status -> ${target}`, changed_fields: ['lifecycle'], change_summary: 'lifecycle updated' });
      }
    }
    const allSources = ['backlog', 'running', 'changed', 'stopped', 'done', 'failed', 'blocked', 'cancelled'] as const;
    for (const target of ['running', 'changed', 'cancelled'] as const) for (const source of allSources) {
      if ((admitted[target] as readonly string[]).includes(source)) continue;
      const card = createInStatus(cards, source, `rejected-${source}-${target}`);
      const before = versionCount(root, card.id);
      expect(() => cards.setStatus(card.id, target)).toThrow(/Invalid status operation/);
      expect(versionCount(root, card.id)).toBe(before);
    }
  });

  it('preserves notifications for running/changed and clears them for both cancellation cases', () => {
    const { root, cards } = setup();
    for (const [source, target] of [['backlog', 'running'], ['blocked', 'running'], ['changed', 'running'], ['blocked', 'changed']] as const) {
      const card = createInStatus(cards, source, `notification-${source}-${target}`);
      cards.enqueueNotification(card.id, { id: `n-${source}-${target}`, content: 'preserve', created_at: settled });
      const committed = cards.setStatus(card.id, target);
      expect(committed.pending_notifications).toHaveLength(1);
      expect(history(root, card.id).changed_fields).toEqual(['lifecycle']);
    }
    const withNotification = cards.create(input('project', 'cancel with notification'));
    cards.enqueueNotification(withNotification.id, { id: 'cancel-notification', content: 'clear', created_at: settled });
    expect(cards.setStatus(withNotification.id, 'cancelled').pending_notifications).toEqual([]);
    expect(history(root, withNotification.id)).toMatchObject({ changed_fields: ['lifecycle', 'pending_notifications'], change_summary: 'lifecycle, pending_notifications updated' });
    const empty = cards.create(input('project', 'cancel empty'));
    expect(cards.setStatus(empty.id, 'cancelled').pending_notifications).toEqual([]);
    expect(history(root, empty.id)).toMatchObject({ changed_fields: ['lifecycle'], change_summary: 'lifecycle updated' });
  });

  it('publishes exact recovery-stop and STOPPED-activation rows while preserving notifications', () => {
    const { root, cards } = setup(); const card = createInStatus(cards, 'running', 'recovery');
    cards.enqueueNotification(card.id, { id: 'recovery-notification', content: 'preserve', created_at: settled });
    expect(cards.stopRunningForRecovery(card.id)).toMatchObject({ lifecycle: { status: 'stopped', result: null, error: null, completed_at: null }, pending_notifications: [expect.objectContaining({ id: 'recovery-notification' })] });
    expect(history(root, card.id)).toMatchObject({ kind: 'status', changed_by_actor: 'runtime', changed_by_surface: 'runtime', change_reason: 'recovery stopped lifecycle', changed_fields: ['lifecycle'], change_summary: 'lifecycle updated' });
    expect(cards.activateStopped(card.id)).toMatchObject({ lifecycle: { status: 'running', result: null, error: null, completed_at: null }, pending_notifications: [expect.objectContaining({ id: 'recovery-notification' })] });
    expect(history(root, card.id)).toMatchObject({ kind: 'status', changed_by_actor: 'runtime', changed_by_surface: 'runtime', change_reason: 'STOPPED activation', changed_fields: ['lifecycle'], change_summary: 'lifecycle updated' });
  });

  it.each([done(), failed(), blocked()])('derives terminal lifecycle and fixed metadata from $status outcomes', (outcome) => {
    const { root, cards } = setup(); const card = cards.create(input()); cards.setStatus(card.id, 'running'); cards.enqueueNotification(card.id, { id: 'n', content: 'notice', created_at: settled });
    const committed = cards.commitActivationOutcome(card.id, outcome, settled);
    expect(committed.status_text).toBe(outcome.summary); expect(committed.status_text_updated_at).toBe(settled); expect(committed.pending_notifications).toEqual([]);
    expect(history(root, card.id)).toMatchObject({ kind: 'terminal', changed_by_actor: 'runtime', changed_by_surface: 'runtime', change_reason: 'terminal lifecycle commit', changed_fields: ['lifecycle', 'status_text', 'status_text_updated_at', 'pending_notifications'], change_summary: 'lifecycle, status_text, status_text_updated_at, pending_notifications updated' });
    if (outcome.status === 'done') expect(committed.lifecycle).toEqual({ status: 'done', result: outcome.result, error: null, completed_at: settled });
    else if (outcome.status === 'failed') expect(committed.lifecycle).toEqual({ status: 'failed', result: outcome.result, error: outcome.summary, completed_at: settled });
    else expect(committed.lifecycle).toEqual({ status: 'blocked', result: outcome.result, error: outcome.summary, completed_at: null });
  });

  it('emits all eight terminal S/T/N delta combinations for done, failed, and blocked', () => {
    for (const outcomeFactory of terminalFactories) for (const sameSummary of [false, true]) for (const sameTime of [false, true]) for (const notifications of [false, true]) {
      const { root, cards } = setup(); const card = cards.create(input()); cards.setStatus(card.id, 'running');
      cards.commitActivationOutcome(card.id, done('prior'), sameTime ? settled : '2026-07-21T00:00:00.000Z'); cards.setStatus(card.id, 'changed'); cards.setStatus(card.id, 'running');
      if (notifications) cards.enqueueNotification(card.id, { id: 'n', content: 'notice', created_at: settled });
      const outcome = outcomeFactory(sameSummary ? 'prior' : 'next');
      const committed = cards.commitActivationOutcome(card.id, outcome, settled);
      const fields = ['lifecycle', ...(!sameSummary ? ['status_text'] : []), ...(!sameTime ? ['status_text_updated_at'] : []), ...(notifications ? ['pending_notifications'] : [])];
      expect(history(root, card.id)).toMatchObject({ kind: 'terminal', changed_by_actor: 'runtime', changed_by_surface: 'runtime', change_reason: 'terminal lifecycle commit', changed_fields: fields, change_summary: `${fields.join(', ')} updated` });
      expect(committed).toMatchObject({ status_text: outcome.summary, status_text_updated_at: settled, pending_notifications: [] });
      expect(committed.lifecycle.result).toEqual(outcome.result);
      expect(committed.lifecycle.completed_at).toBe(outcome.status === 'blocked' ? null : settled);
      expect(committed.lifecycle.error).toBe(outcome.status === 'done' ? null : outcome.summary);
    }
  });

  it('rejects mismatched outcome summaries and non-running terminal publication without append', () => {
    const { root, cards } = setup(); const card = cards.create(input());
    for (const outcome of [done(), failed(), blocked()]) {
      const before = versionCount(root, card.id);
      expect(() => cards.commitActivationOutcome(card.id, outcome, settled)).toThrow(/must be running/);
      expect(versionCount(root, card.id)).toBe(before);
    }
    for (const mismatch of [
      { status: 'done', summary: 'outer', result: workflowResult('DONE', 'inner') },
      { status: 'failed', summary: 'outer', result: runtimeFailure('inner') },
      { status: 'blocked', summary: 'outer', result: workflowResult('BLOCKED', 'inner') },
    ] as const) {
      const running = cards.create(input('project', `mismatch-${mismatch.status}`)); cards.setStatus(running.id, 'running');
      const before = versionCount(root, running.id);
      expect(() => cards.commitActivationOutcome(running.id, mismatch, settled)).toThrow(/summary/);
      expect(versionCount(root, running.id)).toBe(before);
    }
  });

  it('publishes exact notification families', () => {
    const { root, cards } = setup(); const card = cards.create(input());
    cards.enqueueNotification(card.id, { id: 'a', content: 'a', created_at: settled }); expect(history(root, card.id)).toMatchObject({ kind: 'notification_enqueue', change_reason: 'notification enqueued', change_summary: 'notification enqueued', changed_fields: ['pending_notifications'] });
    cards.enqueueNotification(card.id, { id: 'b', content: 'b', created_at: settled });
    const before = versionCount(root, card.id);
    expect(() => cards.removeNotifications(card.id, ['a', 'a'])).toThrow(/unique/);
    expect(() => cards.removeNotifications(card.id, ['missing'])).toThrow(/not pending/);
    expect(versionCount(root, card.id)).toBe(before);
    cards.removeNotifications(card.id, ['a']); expect(history(root, card.id)).toMatchObject({ kind: 'notification_remove', change_reason: 'notifications delivered', change_summary: 'notifications delivered', changed_fields: ['pending_notifications'] });
    expect(cards.read(card.id)!.pending_notifications.map(({ id }) => id)).toEqual(['b']);
    expect(() => cards.removeNotifications(card.id, [])).toThrow();
  });

  it('admits active reorder and moves an interleaved retained tombstone to the stable suffix', () => {
    const { root, cards } = setup(); const first = cards.create(input()); const retained = cards.create(input()); const second = cards.create(input());
    cards.deleteSubtrees([retained.id], () => true);
    expect(cards.read('project')!.children).toEqual([first.id, retained.id, second.id]);
    expect(cards.reorderChildren('project', [first.id, second.id])).toEqual({ ok: true, changed: 2 });
    expect(cards.read('project')!.children).toEqual([first.id, second.id, retained.id]);
    expect(history(root, 'project')).toMatchObject({ kind: 'reorder', changed_by_actor: 'runtime', changed_by_surface: 'runtime', change_reason: 'children reordered', changed_fields: ['children'], change_summary: 'children reordered' });
    expect(cards.reorderChildren('project', [second.id, first.id])).toEqual({ ok: true, changed: 2 });
    expect(cards.reorderChildren('project', [second.id, first.id])).toEqual({ ok: true, changed: 0 });
    expect(cards.reorderChildren('project', [first.id, first.id])).toMatchObject({ ok: false });
  });

  it('uses fixed analyst/runtime deletion metadata', () => {
    const { root, cards } = setup(); const child = cards.create(input()); cards.deleteSubtrees([child.id], () => true);
    const tombstone = readCanonicalGrowingFile(cardStreamFile(root, child.id), cardStreamRowSchema).at(-1)!;
    if (tombstone.kind !== 'card-tombstone') throw new Error('Expected tombstone.');
    expect(tombstone.deletion_history).toMatchObject({ kind: 'delete', changed_by_actor: 'analyst', changed_by_surface: 'runtime', change_reason: 'analyst subtree deletion', changed_fields: ['__deleted__'], change_summary: 'card deleted' });
  });
});
