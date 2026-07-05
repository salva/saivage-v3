import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { CardActor, MAX_NOTIFICATION_DELIVERY_MARKERS, appendNotificationToActorSnapshot, cardActorId, createSupervisorRuntimeApi, isActivatable, readActorSnapshots, saveActorSnapshot, type CardActivationInput, type CardActivationOutcome, type CardActorDeps, type CardProcessorActor } from '../../../src/runtime/actors/index.js';
import { ProcessRunner } from '../../../src/runtime/process-runner.js';
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

function deps(projectRoot: string, store: CardStore): CardActorDeps {
  return { projectRoot, store, provider: { completeTurn: jest.fn() as never }, processRunner: new ProcessRunner(projectRoot), notifyCard: () => ({ ok: true }), lookup: new Map() };
}

function actorFromCard(projectRoot: string, store: CardStore, card: CardRecord, fakeProcessor: CardProcessorActor): CardActor {
  const actor = CardActor.fromCard({ card, deps: deps(projectRoot, store) });
  Object.defineProperty(actor, 'processor', { value: fakeProcessor });
  return actor;
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
    const actor = actorFromCard(projectRoot, store, goal, processor({ status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } }));

    await expect(actor.activate({ kind: 'parent', cardId: 'other' })).rejects.toThrow(/cannot be activated/);
    expect(store.read(goal.id)?.status).toBe('backlog');
  }));

  it('transitions to running, invokes the processor, and commits done before resolving', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const fakeProcessor = processor({ status: 'done', summary: 'project done', result: { kind: 'done', summary: 'project done' } });
    const actor = actorFromCard(projectRoot, store, project, fakeProcessor);

    const outcome = await actor.activate({ kind: 'root' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'project done' });
    expect(fakeProcessor.activate).toHaveBeenCalledWith(expect.objectContaining({ card: expect.objectContaining({ id: 'project' }) }), expect.any(AbortSignal));
    expect(store.read('project')).toMatchObject({ status: 'done', status_text: 'project done' });
    await eventually(() => expect(actor.state()).toBe('parked'));
    expect(readActorSnapshots(projectRoot).map((item) => item.actor_id)).toContain('card:project');
  }));

  it('persists active reconstruction during card activation and clears it on settlement', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    let finish!: () => void;
    const fakeProcessor: CardProcessorActor = {
      activate: jest.fn(async () => new Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>((resolve) => {
        finish = () => resolve({ status: 'done', summary: 'project done', result: { kind: 'done', summary: 'project done' } });
      })),
    };
    const actor = actorFromCard(projectRoot, store, project, fakeProcessor);

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

  it('clears stale active reconstruction when recovering non-running cards', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    store.commitTerminalLifecyclePatch(project.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
    saveActorSnapshot(projectRoot, {
      actor_id: cardActorId(project.id),
      actor_kind: 'card',
      state_value: 'running',
      context: {
        active_reconstruction: { schema_version: 1, kind: 'card_activation', card_id: project.id, processor_actor_id: 'processor:project', caller: { kind: 'root' }, started_at: '2026-06-12T00:00:00.000Z' },
        activationId: 'stale-activation',
      },
      updated_at: '2026-06-12T00:00:00.000Z',
    });

    const actor = actorFromCard(projectRoot, store, store.read(project.id)!, processor({ status: 'done', summary: 'unused', result: { kind: 'done', summary: 'unused' } }));

    expect(actor.state()).toBe('parked');
    expect(readActorSnapshots(projectRoot).find((item) => item.actor_id === cardActorId(project.id))?.context).toMatchObject({ active_reconstruction: null, activationId: null });
  }));

  it('passes a card-owned notification delivery port to activation input', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const deliveredIds: string[] = [];
    const fakeProcessor: CardProcessorActor = {
      activate: jest.fn(async (input: CardActivationInput) => {
        deliveredIds.push(...input.notificationDelivery.deliverNotificationsForInput('planner:project:1').map((item) => item.id));
        return { status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } };
      }) as (input: CardActivationInput) => Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>,
    };
    const actor = actorFromCard(projectRoot, store, project, fakeProcessor);

    actor.enqueueNotification({ id: 'n1', message: 'first', created_at: '2026-06-12T00:00:00.000Z' });
    actor.enqueueNotification({ id: 'n2', message: 'second', created_at: '2026-06-12T00:00:01.000Z' });

    expect(actor.hasPendingNotifications()).toBe(true);
    expect(actor.listPendingNotifications().map((item) => item.id)).toEqual(['n1', 'n2']);

    await actor.activate({ kind: 'root' });

    expect(fakeProcessor.activate).toHaveBeenCalledWith(expect.objectContaining({
      notificationDelivery: actor,
    }), expect.any(AbortSignal));
    expect(deliveredIds).toEqual(['n1', 'n2']);
    expect(actor.hasPendingNotifications()).toBe(false);
    expect(actor.notificationDeliveryMarkers).toEqual([
      expect.objectContaining({ notification_id: 'n1', delivered_to_input_id: 'planner:project:1' }),
      expect.objectContaining({ notification_id: 'n2', delivered_to_input_id: 'planner:project:1' }),
    ]);
  }));

  it('appends notifications to actor snapshots without inventing missing actor state', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);

    const snapshot = appendNotificationToActorSnapshot(projectRoot, cardActorId(project.id), { id: 'restored', message: 'from snapshot', created_at: '2026-06-12T00:00:00.000Z', reason: 'test' });

    expect(snapshot.state_value).toBeNull();

    const persisted = readActorSnapshots(projectRoot).find((item) => item.actor_id === cardActorId(project.id));
    expect(persisted?.state_value).toBeNull();
    expect(persisted?.context.notifications).toEqual([expect.objectContaining({ id: 'restored', message: 'from snapshot' })]);

    const existing = {
      ...persisted!,
      state_value: 'parked',
      context: { ...persisted!.context, custom: true },
    };
    saveActorSnapshot(projectRoot, existing);
    const updated = appendNotificationToActorSnapshot(projectRoot, cardActorId(project.id), { id: 'second', message: 'second', created_at: '2026-06-12T00:00:01.000Z', reason: 'test' });

    expect(updated.state_value).toBe('parked');
    expect(updated.context.custom).toBe(true);
    expect(updated.context.notifications).toEqual([
      expect.objectContaining({ id: 'restored' }),
      expect.objectContaining({ id: 'second' }),
    ]);
  }));

  it('restores pending notifications from the actor snapshot on materialization', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);

    appendNotificationToActorSnapshot(projectRoot, cardActorId(project.id), { id: 'restored', message: 'from snapshot', created_at: '2026-06-12T00:00:00.000Z', reason: 'test' });

    const actor = actorFromCard(projectRoot, store, project, processor({ status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } }));

    expect(actor.listPendingNotifications()).toEqual([expect.objectContaining({ id: 'restored', message: 'from snapshot' })]);
  }));

  it('runtime notifyCard persists inactive card notifications and reopens done cards', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const goal = createGoal(store);
    store.repairTerminalLifecycle(goal.id, {
      status: 'done',
      lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' },
    });
    const runtime = createSupervisorRuntimeApi({
      projectRoot,
      actorStore: store,
      provider: { completeTurn: jest.fn() as never },
      processRunner: new ProcessRunner(projectRoot),
    });

    const result = runtime.notifyCard(goal.id, { id: 'inactive', message: 'wake up', created_at: '2026-06-12T00:00:00.000Z', reason: 'test' });

    expect(result).toEqual({ ok: true });
    expect(store.read(goal.id)?.status).toBe('changed');
    expect(readActorSnapshots(projectRoot).find((item) => item.actor_id === cardActorId(goal.id))?.context.notifications).toEqual([
      expect.objectContaining({ id: 'inactive', message: 'wake up' }),
    ]);
  }));

  it('runtime notifyCard returns structured failure for missing cards', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const runtime = createSupervisorRuntimeApi({
      projectRoot,
      actorStore: store,
      provider: { completeTurn: jest.fn() as never },
      processRunner: new ProcessRunner(projectRoot),
    });

    const result = runtime.notifyCard('missing-card', { id: 'missing', message: 'wake up', created_at: '2026-06-12T00:00:00.000Z', reason: 'test' });

    expect(result).toEqual({ ok: false, reason: 'missing_card', cardId: 'missing-card' });
  }));

  it('records card-owned notification delivery markers by input id', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const actor = actorFromCard(projectRoot, store, project, processor({ status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } }));

    actor.enqueueNotification({ id: 'n1', message: 'first', created_at: '2026-06-12T00:00:00.000Z' });
    actor.enqueueNotification({ id: 'n2', message: 'second', created_at: '2026-06-12T00:00:01.000Z' });

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
    const actor = actorFromCard(projectRoot, store, project, processor({ status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } }));

    for (let index = 0; index < MAX_NOTIFICATION_DELIVERY_MARKERS + 3; index++) {
      actor.enqueueNotification({ id: `n${index}`, message: `notice ${index}`, created_at: '2026-06-12T00:00:00.000Z' });
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
    const actor = actorFromCard(projectRoot, store, goal, runningProcessor);
    const activation = actor.activate({ kind: 'parent', cardId: 'project' });
    await eventually(() => expect(store.read(goal.id)?.status).toBe('running'));

    actor.enqueueNotification({ id: 'n-running', message: 'running context', created_at: '2026-06-12T00:00:00.000Z' });
    const delivered = actor.deliverNotificationsForInput('input:running:1');

    expect(delivered).toEqual([expect.objectContaining({ id: 'n-running' })]);
    expect(actor.listPendingNotifications()).toEqual([]);
    expect(actor.notificationDeliveryMarkers).toEqual([
      expect.objectContaining({ notification_id: 'n-running', delivered_to_input_id: 'input:running:1' }),
    ]);
    expect(store.read(goal.id)?.status).toBe('running');

    finish({ status: 'blocked', summary: 'blocked', result: { kind: 'blocked', summary: 'blocked', resume_reason: 'blocked' } });
    await expect(activation).resolves.toMatchObject({ status: 'blocked' });
  }));

  it('does not reopen done cards when notifications remain undelivered at settlement', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    let actor!: CardActor;
    const fakeProcessor: CardProcessorActor = {
      activate: jest.fn(async () => {
        actor.enqueueNotification({ id: 'n-late', message: 'late running context', created_at: '2026-06-12T00:00:00.000Z' });
        return { status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } };
      }) as (input: CardActivationInput) => Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>,
    };
    actor = actorFromCard(projectRoot, store, project, fakeProcessor);

    const outcome = await actor.activate({ kind: 'root' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'done' });
    await eventually(() => expect(actor.state()).toBe('parked'));
    expect(store.read(project.id)).toMatchObject({ status: 'done', lifecycle: { result: { kind: 'done', summary: 'done' } } });
    expect(actor.listPendingNotifications()).toEqual([expect.objectContaining({ id: 'n-late' })]);
  }));

  it('does not reopen done cards from their own terminal lifecycle notification', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const fakeProcessor: CardProcessorActor = {
      activate: jest.fn(async (input: CardActivationInput) => {
        input.notificationDelivery.deliverNotificationsForInput('fake-input');
        return { status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } };
      }) as (input: CardActivationInput) => Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>,
    };
    const actor = actorFromCard(projectRoot, store, project, fakeProcessor);
    store.setNotifyCard((cardId, notification) => {
      if (cardId !== project.id) return { ok: false, reason: 'missing_card', cardId };
      actor.enqueueNotification(notification);
      return { ok: true };
    });

    const outcome = await actor.activate({ kind: 'root' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'done' });
    await eventually(() => expect(actor.state()).toBe('parked'));
    expect(store.read(project.id)).toMatchObject({ status: 'done', lifecycle: { result: { kind: 'done', summary: 'done' } } });
    expect(actor.listPendingNotifications()).toEqual([]);
  }));

  it('recovers done cards as parked without reopening them', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    store.commitTerminalLifecyclePatch(project.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
    const actor = new CardActor({ card: project, deps: deps(projectRoot, store) });
    actor.notifications = [{ id: 'n-recover', message: 'pending context', created_at: '2026-06-12T00:00:00.000Z' }];

    actor.recover('parked');

    expect(actor.state()).toBe('parked');
    expect(store.read(project.id)?.status).toBe('done');
    expect(actor.listPendingNotifications()).toEqual([expect.objectContaining({ id: 'n-recover' })]);
  }));

  it('treats done-card cancel as a no-op without actor or durable status changes', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    store.commitTerminalLifecyclePatch(project.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
    const actor = actorFromCard(projectRoot, store, store.read(project.id)!, processor({ status: 'done', summary: 'unused', result: { kind: 'done', summary: 'unused' } }));

    actor.cancel({ reason: 'too late' });

    expect(actor.state()).toBe('parked');
    expect(actor.cancelReason).toBeNull();
    expect(store.read(project.id)?.status).toBe('done');
  }));

  it('recovers needs_verification cards as parked and leaves them inactive', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    store.commitTerminalLifecyclePatch(project.id, { status: 'needs_verification', lifecycle: { status: 'needs_verification', result: { kind: 'executor_needs_verification', reason: 'verify', preserved_result: {}, fallback_reason: null, latest_self_report: { result: 'needs_verification', outcome: 'needs_verification', summary: 'verify', status_text: 'verify', at: '2026-06-12T00:00:00.000Z' } }, error: null, completed_at: null } });

    const actor = actorFromCard(projectRoot, store, store.read(project.id)!, processor({ status: 'done', summary: 'unused', result: { kind: 'done', summary: 'unused' } }));

    expect(actor.state()).toBe('parked');
    expect(store.read(project.id)?.status).toBe('needs_verification');
    expect(isActivatable('needs_verification')).toBe(false);
  }));

  it('cancels inactive subtrees while preserving done descendants', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const goal = createGoal(store);
    const doneChild = store.create({ type: 'code', parent: goal.id, depth: 2, title: 'done child', brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    const backlogChild = store.create({ type: 'test', parent: goal.id, depth: 2, title: 'backlog child', brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    store.commitTerminalLifecyclePatch(doneChild.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
    const actor = actorFromCard(projectRoot, store, project, processor({ status: 'done', summary: 'unused', result: { kind: 'done', summary: 'unused' } }));

    actor.cancel({ reason: 'operator cancelled project' });

    await eventually(() => expect(actor.state()).toBe('cancelled'));
    expect(store.read(project.id)?.status).toBe('cancelled');
    expect(store.read(goal.id)?.status).toBe('cancelled');
    expect(store.read(doneChild.id)?.status).toBe('done');
    expect(store.read(backlogChild.id)?.status).toBe('cancelled');
  }));

  it('authoritatively cancels running cards and drops late outcomes without process-runner coupling', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const runningGoal = createGoal(store);
    const runner = new ProcessRunner(projectRoot);
    const stopByOwner = jest.spyOn(runner, 'stopByOwner').mockResolvedValue({ attempted: [], stopped: [], failed: [] });
    let finish!: (outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>) => void;
    const runningProcessor: CardProcessorActor = {
      activate: jest.fn(async () => new Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>((resolve) => { finish = resolve; })),
    };
    const actor = CardActor.fromCard({ card: runningGoal, deps: { ...deps(projectRoot, store), processRunner: runner } });
    Object.defineProperty(actor, 'processor', { value: runningProcessor });
    const activation = actor.activate({ kind: 'parent', cardId: 'project' });
    await eventually(() => expect(store.read(runningGoal.id)?.status).toBe('running'));

    actor.cancel({ reason: 'operator requested stop', cancelled_at: '2026-06-12T00:00:00.000Z' });

    expect(actor.state()).toBe('running');
    expect(store.read(runningGoal.id)?.status).toBe('cancelled');
    await expect(activation).resolves.toMatchObject({ status: 'cancelled', summary: 'operator requested stop' });
    expect(stopByOwner).not.toHaveBeenCalled();

    finish({ status: 'blocked', summary: 'stopped later', result: { kind: 'blocked', summary: 'stopped later', resume_reason: 'manual resume' } });
    await eventually(() => expect(actor.state()).toBe('cancelled'));
    expect(store.read(runningGoal.id)?.status).toBe('cancelled');
  }));
});
