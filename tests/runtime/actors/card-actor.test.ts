import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { CardActor, MAX_NOTIFICATION_DELIVERY_MARKERS, isActivatable, readActorSnapshots, type CardActivationInput, type CardActivationOutcome, type CardProcessorActor } from '../../../src/runtime/actors/index.js';
import type { CardRecord } from '../../../src/schemas/index.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-card-actor-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function createProject(store: CardStore): CardRecord {
  const existing = store.read('project');
  if (existing) return existing;
  return store.create({ type: 'project', parent: null, depth: 0, title: 'project', brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
}

function createGoal(store: CardStore, parent = 'project'): CardRecord {
  return store.create({ type: 'goal', parent, depth: parent === 'project' ? 1 : 2, title: 'goal', brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
}

function processor(outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>): CardProcessorActor {
  return { activate: jest.fn(async () => outcome) as (input: CardActivationInput) => Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>> };
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
    expect(isActivatable('failed')).toBe(false);
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
    expect(fakeProcessor.activate).toHaveBeenCalledWith(expect.objectContaining({ card: expect.objectContaining({ id: 'project' }) }));
    expect(store.read('project')).toMatchObject({ status: 'done', status_text: 'project done' });
    await eventually(() => expect(actor.state()).toBe('done'));
    expect(readActorSnapshots(projectRoot).map((item) => item.actor_id)).toContain('card:project');
  }));

  it('persists active reconstruction during card activation and clears it on settlement', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    let finish!: () => void;
    const fakeProcessor: CardProcessorActor = {
      activate: jest.fn(async () => new Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>((resolve) => {
        finish = () => resolve({ status: 'done', summary: 'project done', result: { kind: 'planner_done', summary: 'project done' } });
      })),
    };
    const actor = CardActor.fromCard({ projectRoot, card: project, store, processor: fakeProcessor });

    const pending = actor.activate({ kind: 'root' });
    await eventually(() => expect(actor.state()).toBe('running'));
    expect(readActorSnapshots(projectRoot).find((item) => item.actor_id === 'card:project')?.context.active_reconstruction).toMatchObject({
      schema_version: 1,
      kind: 'card_activation',
      card_id: 'project',
      processor_actor_id: 'processor:project',
      caller: { kind: 'root' },
    });

    finish();
    await expect(pending).resolves.toMatchObject({ status: 'done' });
    await eventually(() => expect(readActorSnapshots(projectRoot).find((item) => item.actor_id === 'card:project')?.context.active_reconstruction).toBeNull());
  }));

  it('passes a card-owned notification delivery port to activation input', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const deliveredIds: string[] = [];
    const fakeProcessor: CardProcessorActor = {
      activate: jest.fn(async (input: CardActivationInput) => {
        deliveredIds.push(...input.notificationDelivery.deliverNotificationsForInput('planner:project:1').map((item) => item.id));
        return { status: 'done', summary: 'done', result: { kind: 'planner_done', summary: 'done' } };
      }) as (input: CardActivationInput) => Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>,
    };
    const actor = CardActor.fromCard({ projectRoot, card: project, store, processor: fakeProcessor });

    actor.enqueueNotification({ id: 'n1', message: 'first', created_at: '2026-06-12T00:00:00.000Z' });
    actor.enqueueNotification({ id: 'n2', message: 'second', created_at: '2026-06-12T00:00:01.000Z' });

    expect(actor.hasPendingNotifications()).toBe(true);
    expect(actor.listPendingNotifications().map((item) => item.id)).toEqual(['n1', 'n2']);

    await actor.activate({ kind: 'root' });

    expect(fakeProcessor.activate).toHaveBeenCalledWith(expect.objectContaining({
      notificationDelivery: actor,
    }));
    expect(deliveredIds).toEqual(['n1', 'n2']);
    expect(actor.hasPendingNotifications()).toBe(false);
    expect(actor.notificationDeliveryMarkers).toEqual([
      expect.objectContaining({ notification_id: 'n1', delivered_to_input_id: 'planner:project:1' }),
      expect.objectContaining({ notification_id: 'n2', delivered_to_input_id: 'planner:project:1' }),
    ]);
  }));

  it('records card-owned notification delivery markers by input id', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const actor = CardActor.fromCard({ projectRoot, card: project, store, processor: processor({ status: 'done', summary: 'done', result: { kind: 'planner_done', summary: 'done' } }) });

    actor.notify({ id: 'n1', message: 'first', created_at: '2026-06-12T00:00:00.000Z' });
    actor.notify({ id: 'n2', message: 'second', created_at: '2026-06-12T00:00:01.000Z' });

    const delivered = actor.deliverNotificationsForInput('input:project:1');

    expect(delivered.map((item) => item.id)).toEqual(['n1', 'n2']);
    expect(actor.hasPendingNotifications()).toBe(false);
    expect(actor.notificationDeliveryMarkers).toEqual([
      expect.objectContaining({ notification_id: 'n1', delivered_to_input_id: 'input:project:1', delivered_at: expect.any(String) }),
      expect.objectContaining({ notification_id: 'n2', delivered_to_input_id: 'input:project:1', delivered_at: expect.any(String) }),
    ]);
    expect(new Date(actor.notificationDeliveryMarkers[0].delivered_at).toString()).not.toBe('Invalid Date');
    const snapshot = readActorSnapshots(projectRoot).find((item) => item.actor_id === 'card:project');
    expect(snapshot?.context).toMatchObject({
      notificationDeliveryMarkers: [
        expect.objectContaining({ notification_id: 'n1', delivered_to_input_id: 'input:project:1' }),
        expect.objectContaining({ notification_id: 'n2', delivered_to_input_id: 'input:project:1' }),
      ],
    });
  }));

  it('keeps only the latest notification delivery markers', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const actor = CardActor.fromCard({ projectRoot, card: project, store, processor: processor({ status: 'done', summary: 'done', result: { kind: 'planner_done', summary: 'done' } }) });

    for (let index = 0; index < MAX_NOTIFICATION_DELIVERY_MARKERS + 3; index++) {
      actor.notify({ id: `n${index}`, message: `notice ${index}`, created_at: '2026-06-12T00:00:00.000Z' });
      actor.deliverNotificationsForInput(`input:${index}`);
    }

    expect(actor.notificationDeliveryMarkers).toHaveLength(MAX_NOTIFICATION_DELIVERY_MARKERS);
    expect(actor.notificationDeliveryMarkers[0]).toMatchObject({ notification_id: 'n3' });
    expect(actor.notificationDeliveryMarkers.at(-1)).toMatchObject({ notification_id: `n${MAX_NOTIFICATION_DELIVERY_MARKERS + 2}` });
  }));

  it('delivers notifications queued while a card is running', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const goal = createGoal(store);
    let finish!: (outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>) => void;
    const runningProcessor: CardProcessorActor = {
      activate: jest.fn(async () => new Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>((resolve) => { finish = resolve; })),
    };
    const actor = CardActor.fromCard({ projectRoot, card: goal, store, processor: runningProcessor });
    const activation = actor.activate({ kind: 'parent', cardId: 'project' });
    await eventually(() => expect(store.read(goal.id)?.status).toBe('running'));

    actor.notify({ id: 'n-running', message: 'running context', created_at: '2026-06-12T00:00:00.000Z' });
    const delivered = actor.deliverNotificationsForInput('input:running:1');

    expect(delivered).toEqual([expect.objectContaining({ id: 'n-running' })]);
    expect(actor.listPendingNotifications()).toEqual([]);
    expect(actor.notificationDeliveryMarkers).toEqual([
      expect.objectContaining({ notification_id: 'n-running', delivered_to_input_id: 'input:running:1' }),
    ]);
    expect(store.read(goal.id)?.status).toBe('running');

    finish({ status: 'blocked', summary: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'blocked', resume_reason: 'blocked' } });
    await expect(activation).resolves.toMatchObject({ status: 'blocked' });
  }));

  it('reopens done cards as changed when notifications remain undelivered at settlement', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    let actor!: CardActor;
    const fakeProcessor: CardProcessorActor = {
      activate: jest.fn(async () => {
        actor.notify({ id: 'n-late', message: 'late running context', created_at: '2026-06-12T00:00:00.000Z' });
        return { status: 'done', summary: 'done', result: { kind: 'planner_done', summary: 'done' } };
      }) as (input: CardActivationInput) => Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>,
    };
    actor = CardActor.fromCard({ projectRoot, card: project, store, processor: fakeProcessor });

    const outcome = await actor.activate({ kind: 'root' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'done' });
    await eventually(() => expect(actor.state()).toBe('changed'));
    expect(store.read(project.id)).toMatchObject({ status: 'changed', lifecycle: { result: { kind: 'planner_done', summary: 'done' } } });
    expect(actor.listPendingNotifications()).toEqual([expect.objectContaining({ id: 'n-late' })]);
  }));

  it('does not reopen a done card during recovery', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    store.commitTerminalLifecyclePatch(project.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'planner_done', summary: 'done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
    const actor = new CardActor({ projectRoot, cardId: project.id, store, processor: processor({ status: 'done', summary: 'unused', result: { kind: 'planner_done', summary: 'unused' } }) });
    actor.notifications = [{ id: 'n-recover', message: 'pending context', created_at: '2026-06-12T00:00:00.000Z' }];

    actor.recover('done');

    expect(actor.state()).toBe('done');
    expect(store.read(project.id)?.status).toBe('done');
    expect(actor.listPendingNotifications()).toEqual([expect.objectContaining({ id: 'n-recover' })]);
  }));

  it('treats done-card cancel as a no-op without actor or durable status changes', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    store.commitTerminalLifecyclePatch(project.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'planner_done', summary: 'done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
    const actor = CardActor.fromCard({ projectRoot, card: store.read(project.id)!, store, processor: processor({ status: 'done', summary: 'unused', result: { kind: 'planner_done', summary: 'unused' } }) });

    actor.cancel({ reason: 'too late' });

    expect(actor.state()).toBe('done');
    expect(actor.cancelReason).toBeNull();
    expect(store.read(project.id)?.status).toBe('done');
  }));

  it('fails fast instead of mapping needs_verification into blocked actor state', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    store.commitTerminalLifecyclePatch(project.id, { status: 'needs_verification', lifecycle: { status: 'needs_verification', result: { kind: 'executor_needs_verification', reason: 'verify', preserved_result: {}, fallback_reason: null, latest_self_report: { result: 'needs_verification', outcome: 'needs_verification', summary: 'verify', status_text: 'verify', at: '2026-06-12T00:00:00.000Z' } }, error: null, completed_at: null } });

    expect(() => CardActor.fromCard({ projectRoot, card: store.read(project.id)!, store, processor: processor({ status: 'done', summary: 'unused', result: { kind: 'planner_done', summary: 'unused' } }) })).toThrow(/needs_verification/);
  }));

  it('marks inactive cards changed while running cards stay running and receive notifications', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const goal = createGoal(store);
    store.commitTerminalLifecyclePatch(goal.id, { status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'blocked', resume_reason: 'blocked' }, error: 'blocked', completed_at: null } });
    const blockedGoal = store.read(goal.id)!;
    const actor = CardActor.fromCard({ projectRoot, card: blockedGoal, store, processor: processor({ status: 'blocked', summary: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'blocked', resume_reason: 'blocked' } }) });

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
    expect(runningActor.notifications).toEqual([
      expect.objectContaining({ reason: 'card_changed', message: 'Card changed: running edit' }),
      expect.objectContaining({ id: 'n2', message: 'running context' }),
    ]);
    finish({ status: 'blocked', summary: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'blocked', resume_reason: 'blocked' } });
    await expect(activation).resolves.toMatchObject({ status: 'blocked' });
  }));

  it('cancels inactive subtrees while preserving done descendants', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const goal = createGoal(store);
    const doneChild = store.create({ type: 'code', parent: goal.id, depth: 2, title: 'done child', brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    const backlogChild = store.create({ type: 'test', parent: goal.id, depth: 2, title: 'backlog child', brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    store.commitTerminalLifecyclePatch(doneChild.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'executor_success', executor: {}, verified_at: '2026-06-12T00:00:00.000Z', latest_self_report: { result: 'done', outcome: 'done', summary: 'done', status_text: 'done', at: '2026-06-12T00:00:00.000Z' }, warnings: [] }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
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
