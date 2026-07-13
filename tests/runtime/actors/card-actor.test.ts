import { initProjectTree, CardStore } from '../../helpers/canonical-project.js';
import { testActorSnapshots } from '../../helpers/actor-snapshots.js';
import { describe, expect, it, jest } from '@jest/globals';
import { testConversationMutations } from '../../helpers/conversation-mutations.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { CardActor, LLMActor, MAX_NOTIFICATION_DELIVERY_MARKERS, cardActorId, createSupervisorRuntimeApi, isActivatable, processorActorId, readActorSnapshot, readActorSnapshots, type CardActivationInput, type CardActivationOutcome, type CardActorDeps, type CardProcessorActor } from '../../../src/runtime/actors/index.js';
import { ProcessRunner } from '../../../src/runtime/process-runner.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import type { CardRecord } from '../../../src/schemas/index.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { ReadModelChangeBroadcaster } from '../../../src/application/read-model-changes.js';

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
  return store.create({ type: 'project', parent: null, depth: 0, title: 'project', brief: 'Project brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
}

function createGoal(store: CardStore, parent = 'project'): CardRecord {
  return store.create({ type: 'goal', parent, depth: parent === 'project' ? 1 : 2, title: 'goal', brief: 'Goal brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
}

function processor(outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>): CardProcessorActor {
  return { activate: jest.fn(async () => outcome) as (input: CardActivationInput) => Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>> };
}

function deps(projectRoot: string, store: CardStore): CardActorDeps {
  return { projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), store, provider: { completeTurn: jest.fn() as never }, promptTemplates: createTestPromptTemplateRegistry(), processRunner: new ProcessRunner(projectRoot), notifyCard: () => ({ ok: true }), lookup: new Map() };
}

function cardActive(cardId: string): Record<string, unknown> {
  return { schema_version: 1, kind: 'card_activation', card_id: cardId, processor_actor_id: processorActorId(cardId), caller: { kind: 'root' }, started_at: '2026-06-12T00:00:00.000Z' };
}

function processorActive(cardId: string): Record<string, unknown> {
  return { schema_version: 1, kind: 'processor_activation', processor_kind: 'planning', card_id: cardId, caller: { kind: 'root' }, activation_counter: 1, started_at: '2026-06-12T00:00:00.000Z' };
}

function plannerLlmActive(cardId: string): Record<string, unknown> {
  const inputId = `planner:${cardId}:1`;
  return { schema_version: 1, kind: 'llm_turn', agent_id: `planner:${cardId}`, role: 'planner', card_id: cardId, input_id: inputId, input: { inputId, agentId: `planner:${cardId}`, role: 'planner', sessionId: `planner:${cardId}`, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId } }, provider_call_id: null, waiting_tool_call: null, delivered_tool_call_ids: [], tool_delivery_counter: 0, started_at: '2026-06-12T00:00:00.000Z' };
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
    testActorSnapshots(projectRoot).save({
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

  it('fresh activation does not recover stale persisted LLM snapshots', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    testActorSnapshots(projectRoot).save({
      actor_id: 'planner:project',
      actor_kind: 'llm',
      state_value: 'calling_provider',
      context: { cardId: project.id, active_reconstruction: plannerLlmActive(project.id) },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    const provider = { completeTurn: jest.fn(async () => new Promise<never>(() => undefined)) };
    const fromActive = jest.spyOn(LLMActor, 'fromActiveReconstruction');
    const actor = CardActor.fromCard({ card: project, deps: { ...deps(projectRoot, store), provider } });

    void actor.activate({ kind: 'root' });

    await eventually(() => expect(provider.completeTurn).toHaveBeenCalledTimes(1));
    expect(fromActive).not.toHaveBeenCalled();
    expect(actor.state()).toBe('running');
    fromActive.mockRestore();
  }));

  it('recovery activation lazily adopts calling-provider LLM snapshots through recoverActive', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    store.setStatus(project.id, 'running');
    testActorSnapshots(projectRoot).save({
      actor_id: cardActorId(project.id),
      actor_kind: 'card',
      state_value: 'running',
      context: { cardId: project.id, active_reconstruction: cardActive(project.id) },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    testActorSnapshots(projectRoot).save({
      actor_id: 'planner:project',
      actor_kind: 'llm',
      state_value: 'calling_provider',
      context: { cardId: project.id, active_reconstruction: plannerLlmActive(project.id) },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    testActorSnapshots(projectRoot).save({
      actor_id: processorActorId(project.id),
      actor_kind: 'processor',
      state_value: 'planning',
      context: { cardId: project.id, active_reconstruction: processorActive(project.id) },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    const gate = new RuntimeGate(false);
    const provider = { completeTurn: jest.fn(async () => new Promise<never>(() => undefined)) };
    const fromActive = jest.spyOn(LLMActor, 'fromActiveReconstruction');
    const actor = CardActor.fromCard({ card: store.read(project.id)!, deps: { ...deps(projectRoot, store), provider, gate }, deferRunningRecovery: true });

    actor.recoverCurrentCardState();

    expect(fromActive).toHaveBeenCalledTimes(1);
    expect(readActorSnapshot(projectRoot, 'planner:project')?.state_value).toBe('calling_provider');
    expect(provider.completeTurn).not.toHaveBeenCalled();
    gate.open();
    await eventually(() => expect(provider.completeTurn).toHaveBeenCalledTimes(1));
    fromActive.mockRestore();
  }));

  it('defers processor start during Stage 1 recovery construction', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    store.setStatus(project.id, 'running');
    testActorSnapshots(projectRoot).save({
      actor_id: cardActorId(project.id),
      actor_kind: 'card',
      state_value: 'running',
      context: { cardId: project.id, active_reconstruction: cardActive(project.id) },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    const processorSnapshot = {
      actor_id: processorActorId(project.id),
      actor_kind: 'processor' as const,
      state_value: 'planning',
      context: { cardId: project.id, active_reconstruction: processorActive(project.id) },
      updated_at: '2026-06-12T00:00:00.000Z',
    };
    testActorSnapshots(projectRoot).save(processorSnapshot);
    const gate = new RuntimeGate(false);
    const provider = { completeTurn: jest.fn() as never };

    const actor = CardActor.fromCard({ card: store.read(project.id)!, deps: { ...deps(projectRoot, store), provider, gate }, deferRunningRecovery: true });

    expect(readActorSnapshot(projectRoot, processorActorId(project.id))).toEqual(processorSnapshot);
    expect((actor.processor as unknown as { state(): string | undefined }).state()).toBeUndefined();

    actor.recoverCurrentCardState();

    expect((actor.processor as unknown as { state(): string | undefined }).state()).toBe('planning');
    expect(readActorSnapshot(projectRoot, processorActorId(project.id))).toMatchObject({
      state_value: 'planning',
      context: { active_reconstruction: expect.objectContaining({ kind: 'processor_activation', card_id: project.id }) },
    });
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

    const activationInput = (fakeProcessor.activate as jest.MockedFunction<CardProcessorActor['activate']>).mock.calls[0][0];
    expect(activationInput.notificationDelivery).not.toBe(actor);
    expect(activationInput.notificationDelivery).toEqual({ deliverNotificationsForInput: expect.any(Function) });
    expect(activationInput.notificationDelivery).not.toHaveProperty('hasPendingNotifications');
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

    const snapshot = testActorSnapshots(projectRoot).appendNotification(cardActorId(project.id), { id: 'restored', message: 'from snapshot', created_at: '2026-06-12T00:00:00.000Z', reason: 'test' });

    expect(snapshot.state_value).toBeNull();

    const persisted = readActorSnapshots(projectRoot).find((item) => item.actor_id === cardActorId(project.id));
    expect(persisted?.state_value).toBeNull();
    expect(persisted?.context.notifications).toEqual([expect.objectContaining({ id: 'restored', message: 'from snapshot' })]);

    const existing = {
      ...persisted!,
      state_value: 'parked',
      context: { ...persisted!.context, custom: true },
    };
    testActorSnapshots(projectRoot).save(existing);
    const updated = testActorSnapshots(projectRoot).appendNotification(cardActorId(project.id), { id: 'second', message: 'second', created_at: '2026-06-12T00:00:01.000Z', reason: 'test' });

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

    testActorSnapshots(projectRoot).appendNotification(cardActorId(project.id), { id: 'restored', message: 'from snapshot', created_at: '2026-06-12T00:00:00.000Z', reason: 'test' });

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
    const readModelChanges = new ReadModelChangeBroadcaster();
    const runtimeChanged = jest.fn();
    readModelChanges.subscribe({ runtimeChanged, cardStateChanged: jest.fn(), agentsChanged: jest.fn(), conversationChanged: jest.fn() });
    const runtime = createSupervisorRuntimeApi({
      readModelChanges,
      projectRoot, conversations: testConversationMutations(projectRoot),
      promptTemplates: createTestPromptTemplateRegistry(),
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
    expect(runtimeChanged).toHaveBeenCalledTimes(1);
  }));

  it('runtime notifyCard returns structured failure for missing cards', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const runtime = createSupervisorRuntimeApi({
      readModelChanges: new ReadModelChangeBroadcaster(),
      projectRoot, conversations: testConversationMutations(projectRoot),
      promptTemplates: createTestPromptTemplateRegistry(),
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

  it('cancels inactive subtrees while preserving done descendants', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const goal = createGoal(store);
    const doneChild = store.create({ type: 'code', parent: goal.id, depth: 2, title: 'done child', brief: 'Done child brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    const backlogChild = store.create({ type: 'test', parent: goal.id, depth: 2, title: 'backlog child', brief: 'Backlog child brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
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
