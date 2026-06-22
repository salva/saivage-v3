import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { CardActor, isActivatable, readActorSnapshots, type CardActivationInput, type CardActivationOutcome, type CardProcessorActor } from '../../../src/runtime/actors/index.js';
import type { CardRecord } from '../../../src/schemas/index.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-card-actor-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function createProject(store: CardStore): CardRecord {
  return store.create({ type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
}

function createGoal(store: CardStore, parent = 'project'): CardRecord {
  return store.create({ type: 'goal', parent, depth: parent === 'project' ? 1 : 2, title: 'goal', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
}

function processor(outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>): CardProcessorActor {
  return { activate: jest.fn(async () => outcome) as (input: CardActivationInput, signal: AbortSignal) => Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>> };
}

async function eventually(assertion: () => void, attempts = 20): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try { assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 0)); }
  }
  throw lastError;
}

describe('CardActor', () => {
  it('defines activatable card statuses', () => {
    expect(isActivatable('backlog')).toBe(true);
    expect(isActivatable('changed')).toBe(true);
    expect(isActivatable('blocked')).toBe(true);
    expect(isActivatable('failed')).toBe(true);
    expect(isActivatable('running')).toBe(false);
    expect(isActivatable('done')).toBe(false);
    expect(isActivatable('cancelled')).toBe(false);
  });

  it('rejects activation from a non-parent caller', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const goal = createGoal(store);
    const actor = CardActor.fromCard({ projectRoot, card: goal, store, processor: processor({ status: 'done', summary: 'done', result: { kind: 'planner_done', summary: 'done' } }) });

    await expect(actor.activate({ kind: 'parent', cardId: 'other' })).rejects.toThrow(/cannot be activated/);
    expect(store.read(goal.id)?.status).toBe('backlog');
  }));

  it('transitions to running, invokes the processor, and commits done before resolving', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const fakeProcessor = processor({ status: 'done', summary: 'project done', result: { kind: 'planner_done', summary: 'project done' } });
    const actor = CardActor.fromCard({ projectRoot, card: project, store, processor: fakeProcessor });

    const outcome = await actor.activate({ kind: 'root' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'project done' });
    expect(fakeProcessor.activate).toHaveBeenCalledWith(expect.objectContaining({ card: expect.objectContaining({ id: 'project' }) }), expect.any(AbortSignal));
    expect(store.read('project')).toMatchObject({ status: 'done', status_text: 'project done' });
    await eventually(() => expect(actor.state()).toBe('done'));
    expect(readActorSnapshots(projectRoot).map((item) => item.actor_id)).toContain('card:project');
  }));

  it('owns and drains card-addressed notifications for activation input', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const fakeProcessor = processor({ status: 'done', summary: 'done', result: { kind: 'planner_done', summary: 'done' } });
    const actor = CardActor.fromCard({ projectRoot, card: project, store, processor: fakeProcessor });

    actor.enqueueNotification({ id: 'n1', message: 'first', created_at: '2026-06-12T00:00:00.000Z' });
    actor.enqueueNotification({ id: 'n2', message: 'second', created_at: '2026-06-12T00:00:01.000Z' });

    expect(actor.hasPendingNotifications()).toBe(true);
    expect(actor.listPendingNotifications().map((item) => item.id)).toEqual(['n1', 'n2']);

    await actor.activate({ kind: 'root' });

    expect(fakeProcessor.activate).toHaveBeenCalledWith(expect.objectContaining({
      notifications: [
        expect.objectContaining({ id: 'n1' }),
        expect.objectContaining({ id: 'n2' }),
      ],
    }), expect.any(AbortSignal));
    expect(actor.hasPendingNotifications()).toBe(false);
  }));

  it('marks inactive cards changed while running cards stay running and receive notifications', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const goal = createGoal(store);
    const actor = CardActor.fromCard({ projectRoot, card: goal, store, processor: processor({ status: 'blocked', summary: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'blocked', resume_reason: 'blocked' } }) });

    actor.markChanged({ reason: 'operator edit' });

    await eventually(() => expect(actor.state()).toBe('changed'));
    expect(store.read(goal.id)?.status).toBe('changed');
    actor.notify({ id: 'n1', message: 'new context', created_at: '2026-06-12T00:00:00.000Z' });
    expect(actor.notifications).toHaveLength(1);

    const runningGoal = createGoal(store);
    let finish!: (outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>) => void;
    const runningProcessor: CardProcessorActor = {
      activate: jest.fn(async () => new Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>((resolve) => { finish = resolve; })),
    };
    const runningActor = CardActor.fromCard({ projectRoot, card: runningGoal, store, processor: runningProcessor });
    const activation = runningActor.activate({ kind: 'parent', cardId: 'project' });
    await eventually(() => expect(store.read(runningGoal.id)?.status).toBe('running'));

    runningActor.markChanged({ reason: 'running edit' });
    runningActor.notify({ id: 'n2', message: 'running context', created_at: '2026-06-12T00:00:00.000Z' });

    expect(store.read(runningGoal.id)?.status).toBe('running');
    expect(runningActor.notifications).toHaveLength(1);
    finish({ status: 'blocked', summary: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'blocked', resume_reason: 'blocked' } });
    await expect(activation).resolves.toMatchObject({ status: 'blocked' });
  }));

  it('cancels inactive subtrees while preserving done descendants', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const goal = createGoal(store);
    const doneChild = store.create({ type: 'code', parent: goal.id, depth: 2, title: 'done child', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
    const backlogChild = store.create({ type: 'test', parent: goal.id, depth: 2, title: 'backlog child', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
    store.commitTerminalLifecyclePatch(doneChild.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'executor_success', executor: {}, generated_files: [], verified_at: '2026-06-12T00:00:00.000Z', latest_self_report: { result: 'done', outcome: 'done', summary: 'done', status_text: 'done', at: '2026-06-12T00:00:00.000Z' }, warnings: [] }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
    const actor = CardActor.fromCard({ projectRoot, card: project, store, processor: processor({ status: 'done', summary: 'unused', result: { kind: 'planner_done', summary: 'unused' } }) });

    actor.cancel({ reason: 'operator cancelled project' });

    await eventually(() => expect(actor.state()).toBe('cancelled'));
    expect(store.read(project.id)?.status).toBe('cancelled');
    expect(store.read(goal.id)?.status).toBe('cancelled');
    expect(store.read(doneChild.id)?.status).toBe('done');
    expect(store.read(backlogChild.id)?.status).toBe('cancelled');
  }));

  it('best-effort cancels running cards by queuing notification only', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const runningGoal = createGoal(store);
    let finish!: (outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>) => void;
    const runningProcessor: CardProcessorActor = {
      activate: jest.fn(async () => new Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>((resolve) => { finish = resolve; })),
    };
    const actor = CardActor.fromCard({ projectRoot, card: runningGoal, store, processor: runningProcessor });
    const activation = actor.activate({ kind: 'parent', cardId: 'project' });
    await eventually(() => expect(store.read(runningGoal.id)?.status).toBe('running'));

    actor.cancel({ reason: 'operator requested stop', cancelled_at: '2026-06-12T00:00:00.000Z' });

    expect(actor.state()).toBe('running');
    expect(store.read(runningGoal.id)?.status).toBe('running');
    expect(actor.listPendingNotifications()).toEqual([expect.objectContaining({
      id: `cancel:${runningGoal.id}:2026-06-12T00:00:00.000Z`,
      reason: 'cancel_requested',
      message: 'Cancellation requested: operator requested stop',
    })]);
    await expect(Promise.race([activation.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('pending'), 0))])).resolves.toBe('pending');

    finish({ status: 'blocked', summary: 'stopped later', result: { kind: 'planner_blocked', blocked_reason: 'stopped later', resume_reason: 'manual resume' } });
    await expect(activation).resolves.toMatchObject({ status: 'blocked', summary: 'stopped later' });
    expect(store.read(runningGoal.id)?.status).toBe('blocked');
  }));
});
