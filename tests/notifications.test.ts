import { testActorSnapshots } from './helpers/actor-snapshots.js';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { testConversationMutations } from './helpers/conversation-mutations.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CardStore } from '../src/cards/card-store.js';
import { initProjectTree } from '../src/persistence/file-tree.js';
import { clearProjectNotificationDeliveryAdapters, clearProjectNotificationEventBus, NotificationDeliveryService, setProjectNotificationDeliveryAdapters, setProjectNotificationEventBus, type NotificationDeliveryContext, type NotificationQueueEntry } from '../src/notifications/index.js';
import { queueNotification, resolveRecipient } from '../src/notifications/notification-triggers.js';
import { EventBus } from '../src/events/index.js';
import { CardActor, PlanningCardProcessorActor, type CardActorDeps } from '../src/runtime/actors/index.js';
import { ProcessRunner } from '../src/runtime/process-runner.js';
import { queue_notification } from '../src/tools/analyst-misc-tools.js';
import { createPlannerControlProvider } from '../src/tools/planner-control-provider.js';
import { listControlActions } from '../src/persistence/control-action-audit.js';
import { createTestAnalystRuntime } from './helpers/test-runtime-application.js';
import type { CardRecord } from '../src/schemas/types.js';
import type { NewCardInput } from '../src/cards/lifecycle.js';
import type { LlmInvocationInput, LLMProviderPort } from '../src/runtime/actors/index.js';
import type { ToolContext } from '../src/tools/analyst-tool-types.js';
import { createTestPromptTemplateRegistry } from './helpers/prompt-template-registry.js';

const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

function expectNotifyNotificationId(id: string, kind: string): void {
  expect(id).toMatch(new RegExp(`^notify:${kind}:\\d{4}-\\d{2}-\\d{2}T.*:${uuidPattern}$`, 'i'));
}

function notificationIdFromCall(call: unknown): string {
  return (call as [string, { id: string }])[1].id;
}

function cardActorDeps(projectRoot: string, store: CardStore, provider: LLMProviderPort): CardActorDeps {
  return { projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), store, provider, promptTemplates: createTestPromptTemplateRegistry(), processRunner: new ProcessRunner(projectRoot), notifyCard: () => ({ ok: true }), lookup: new Map() };
}

function makeCard(overrides: Partial<NewCardInput> & { id?: string; type: NewCardInput['type']; title: string }): NewCardInput & { id?: string } {
  return { parent: 'project', depth: 1, brief: overrides.title, status: 'backlog', subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', assigned_to: null, depends_on: [], related: [], lifecycle: ({ status: overrides.status ?? 'backlog', result: null, error: null, completed_at: null } as CardRecord['lifecycle']), metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, retries: 0, ...overrides };
}

function entry(kind: string, body = kind) {
  return { kind, body, queued_at: '2026-01-01T00:00:00.000Z', source_actor: 'runtime' as const, source_surface: 'runtime' as const };
}

function activeLlm(projectRoot: string, sessionId: string, stateValue: 'calling_provider' | 'waiting_tool' | 'idle' = 'calling_provider'): void {
  testActorSnapshots(projectRoot).save({ actor_id: sessionId, actor_kind: 'llm', state_value: stateValue, context: {}, updated_at: '2026-01-01T00:00:00.000Z' });
}

describe('NotificationDeliveryService', () => {
  it('emits notification_added and dispatches adapters without retaining queue state', () => {
    const eventBus = new EventBus();
    const events: unknown[] = [];
    const deliveries: Array<{ entry: NotificationQueueEntry; context: NotificationDeliveryContext }> = [];
    eventBus.subscribe('notification_added', (event) => { events.push(event.payload); });
    const service = new NotificationDeliveryService([{ name: 'test', deliver: (deliveredEntry, context) => { deliveries.push({ entry: deliveredEntry, context }); } }], eventBus);

    service.enqueue('session-1', entry('first'));

    expect(events).toEqual([{ session_id: 'session-1', notification_kind: 'first' }]);
    expect(deliveries).toEqual([{ entry: entry('first'), context: { target: 'session', sessionId: 'session-1' } }]);
  });
});

describe('queueNotification recipient resolution', () => {
  let projectRoot: string;
  let store: CardStore;
  let deliveries: Array<{ entry: NotificationQueueEntry; context: NotificationDeliveryContext }>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-notifications-'));
    initProjectTree(projectRoot);
    writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), JSON.stringify({
      models: { default: ['test-analyst-model'], analyst: ['test-analyst-model'] },
      providers: { test: { models: ['test-analyst-model'], apiKey: 'test-key', baseUrl: 'http://test-provider.invalid/v1' } },
    }));
    store = new CardStore(projectRoot);
    deliveries = [];
    setProjectNotificationDeliveryAdapters(projectRoot, [{ name: 'test', deliver: (deliveredEntry, context) => { deliveries.push({ entry: deliveredEntry, context }); } }]);
  });

  afterEach(() => {
    clearProjectNotificationDeliveryAdapters(projectRoot);
    clearProjectNotificationEventBus(projectRoot);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('emits queued notifications on the registered project event bus', () => {
    activeLlm(projectRoot, 'planner:project');
    const eventBus = new EventBus();
    const events: unknown[] = [];
    eventBus.subscribe('notification_added', (event) => { events.push(event.payload); });
    setProjectNotificationEventBus(projectRoot, eventBus);

    queueNotification(projectRoot, { kind: 'session', sessionId: 'planner:project' }, 'runtime_state', 'paused', { actor: 'runtime', surface: 'runtime' });

    expect(events).toEqual([{ session_id: 'planner:project', notification_kind: 'runtime_state' }]);
  });

  it('resolves and queues card recipients to card notification delivery and external sessions', () => {
    const goal = store.create(makeCard({ id: 'goal-1', type: 'goal', title: 'Goal', status: 'running' }));
    const child = store.create(makeCard({ id: 'code-1', type: 'code', title: 'Child', parent: goal.id, depth: 2 }));
    activeLlm(projectRoot, `executor:${child.id}`);

    expect(resolveRecipient(projectRoot, store, child.id)).toEqual({ kind: 'card', cardId: child.id });
    const notifyCard = jest.fn(() => ({ ok: true as const }));
    const result = queueNotification(projectRoot, { kind: 'card', cardId: child.id }, 'card_changed', 'card body', { actor: 'runtime', surface: 'runtime' }, store, notifyCard);

    expect(result).toMatchObject({ ok: true, cardDeliveries: [{ cardId: child.id, result: { ok: true } }], sessionDeliveries: [`executor:${child.id}`] });
    expectNotifyNotificationId(result.notificationId, 'card_changed');
    expect(notifyCard).toHaveBeenCalledWith(child.id, expect.objectContaining({ message: 'card body', reason: 'card_changed' }));
    expect(notificationIdFromCall(notifyCard.mock.calls[0])).toBe(result.notificationId);
    expect(deliveries).toEqual([expect.objectContaining({ context: { target: 'session', sessionId: `executor:${child.id}` }, entry: expect.objectContaining({ kind: 'card_changed', body: 'card body' }) })]);
  });

  it('resolves and queues role recipients to currently active matching sessions', () => {
    activeLlm(projectRoot, 'planner:project-calling', 'calling_provider');
    activeLlm(projectRoot, 'planner:project-waiting', 'waiting_tool');
    activeLlm(projectRoot, 'planner:project-idle', 'idle');
    activeLlm(projectRoot, 'executor:project');

    expect(resolveRecipient(projectRoot, store, 'planner')).toEqual({ kind: 'role', role: 'planner' });
    const notifyCard = jest.fn(() => ({ ok: true as const }));
    queueNotification(projectRoot, { kind: 'role', role: 'planner' }, 'runtime_state', 'paused', { actor: 'runtime', surface: 'runtime' }, undefined, notifyCard);

    expect(notifyCard).toHaveBeenCalledWith('project-calling', expect.objectContaining({ message: 'paused', reason: 'runtime_state' }));
    expect(notifyCard).toHaveBeenCalledWith('project-waiting', expect.objectContaining({ message: 'paused', reason: 'runtime_state' }));
    expect(notifyCard).toHaveBeenCalledTimes(2);
    expect(deliveries.map((delivery) => delivery.context.sessionId).sort()).toEqual(['planner:project-calling', 'planner:project-waiting']);
  });

  it('resolves and queues explicit session recipients to exactly that session', () => {
    activeLlm(projectRoot, 'reviewer:project:assessment-1');

    expect(resolveRecipient(projectRoot, store, 'reviewer:project:assessment-1')).toEqual({ kind: 'session', sessionId: 'reviewer:project:assessment-1' });
    const notifyCard = jest.fn(() => ({ ok: true as const }));
    queueNotification(projectRoot, { kind: 'session', sessionId: 'reviewer:project:assessment-1' }, 'review', 'please review', { actor: 'planner', surface: 'runtime' }, undefined, notifyCard);

    expect(notifyCard).toHaveBeenCalledWith('project', expect.objectContaining({ message: 'please review', reason: 'review' }));
    expect(deliveries).toEqual([expect.objectContaining({ context: { target: 'session', sessionId: 'reviewer:project:assessment-1' }, entry: expect.objectContaining({ kind: 'review', body: 'please review' }) })]);
  });

  it('returns structured missing-card delivery results while preserving session delivery', () => {
    const goal = store.create(makeCard({ id: 'goal-missing-after-resolution', type: 'goal', title: 'Goal', status: 'running' }));
    activeLlm(projectRoot, `planner:${goal.id}`);
    const notifyCard = jest.fn(() => ({ ok: false as const, reason: 'missing_card' as const, cardId: goal.id }));

    const result = queueNotification(projectRoot, { kind: 'card', cardId: goal.id }, 'card_changed', 'body', { actor: 'runtime', surface: 'runtime' }, store, notifyCard);

    expect(result).toMatchObject({ ok: false, cardDeliveries: [{ cardId: goal.id, result: { ok: false, reason: 'missing_card', cardId: goal.id } }], sessionDeliveries: [`planner:${goal.id}`] });
    expect(deliveries.map((delivery) => delivery.context.sessionId)).toEqual([`planner:${goal.id}`]);
  });

  it('routes edit-card patch notifications through notifyCard and preserves session delivery', () => {
    const card = store.create(makeCard({ id: 'edit-target', type: 'goal', title: 'Edit target', status: 'running' }));
    activeLlm(projectRoot, `planner:${card.id}`);
    const notifyCard = jest.fn(() => ({ ok: true as const }));
    store.setNotifyCard(notifyCard);

    store.mutateCard(card.id, { title: 'Edited target' }, { actor: 'planner', surface: 'runtime' });

    expect(notifyCard).toHaveBeenCalledWith(card.id, expect.objectContaining({ message: expect.stringContaining(`${card.id} updated`), reason: 'card_changed' }));
    expect(deliveries.map((delivery) => delivery.context.sessionId)).toEqual([`planner:${card.id}`]);
  });

  it('does not throw edit-card mutations when notifyCard reports a missing card', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const card = store.create(makeCard({ id: 'edit-missing-delivery', type: 'goal', title: 'Missing delivery', status: 'running' }));
    store.setNotifyCard(() => ({ ok: false, reason: 'missing_card', cardId: card.id }));

    try {
      expect(() => store.mutateCard(card.id, { title: 'Still persisted' }, { actor: 'planner', surface: 'runtime' })).not.toThrow();
      expect(store.read(card.id)?.title).toBe('Still persisted');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('card_patch_notification_delivery_failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('reports planner queue_notification delivery failures using tool result conventions', async () => {
    const goal = store.create(makeCard({ id: 'planner-goal', type: 'goal', title: 'Planner goal', status: 'running' }));
    const provider = createPlannerControlProvider({
      projectRoot,
      parentCardId: 'project',
      sessionId: 'planner:project',
      store,
      children: { get: () => null },
      notifyCard: () => ({ ok: false, reason: 'missing_card', cardId: goal.id }),
    });
    const tool = provider.tools.find((item) => item.name === 'queue_notification');

    const result = await tool?.executor({ recipient: goal.id, kind: 'heads_up', body: 'planner body' }, new AbortController().signal);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: `Notification delivery failed for missing card(s): ${goal.id}`,
      data: expect.objectContaining({ queued: false, recipient: goal.id }),
    }));
    const audit = listControlActions(projectRoot).find((entry) => entry.action === 'notification.queue' && entry.target_id === goal.id);
    expect(audit).toMatchObject({ outcome: 'error', error: `Notification delivery failed for missing card(s): ${goal.id}` });
  });

  it('delivers queued card notifications through notifyCard into the next planner LLM input', async () => {
    const goal = store.create(makeCard({ id: 'reviewed', type: 'goal', title: 'Reviewed' }));
    store.repairTerminalLifecycle(goal.id, {
      status: 'done',
      lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' },
    });
    const deps = createTestAnalystRuntime({ projectRoot, cardStore: store });
    const ctx: ToolContext = { projectRoot, processRunner: deps.processRunner, store, actor: 'analyst', surface: 'web-chat', runtime: deps.runtime, restartServerAvailable: false };

    const result = await queue_notification(ctx, { recipient: goal.id, kind: 'review_update', body: 'reviewer left actionable feedback' });

    expect(result).toEqual({ success: true, data: { queued: true, recipient: goal.id } });
    expect(store.read(goal.id)?.status).toBe('changed');

    const capturedInputs: LlmInvocationInput[] = [];
    let turn = 0;
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        capturedInputs.push(input);
        turn++;
        if (turn === 1) {
          return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'write-status', type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({ path: 'record:///status.md?v=next', content: 'status' }) } }] }, provider_exchanges: [] };
        }
        return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'emit-failed', type: 'function' as const, function: { name: 'emit_result', arguments: JSON.stringify({ status: 'failed', summary: 'done capturing notification' }) } }] }, provider_exchanges: [] };
      }),
    };
    const processor = new PlanningCardProcessorActor({
      projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot),
      promptTemplates: createTestPromptTemplateRegistry(),
      cardId: goal.id,
      store,
      children: { get: () => null },
      provider,
    });
    processor.start();
    const actor = CardActor.fromCard({ card: store.read(goal.id)!, deps: cardActorDeps(projectRoot, store, provider) });
    Object.defineProperty(actor, 'processor', { value: processor });

    await expect(actor.activate({ kind: 'parent', cardId: 'project' })).resolves.toMatchObject({ status: 'failed' });

    const firstInput = capturedInputs[0];
    expect(firstInput).toBeDefined();
    expect(firstInput.contextMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'reviewer left actionable feedback' }),
    ]));
    expect(actor.listPendingNotifications()).toEqual([]);
    expect(actor.notificationDeliveryMarkers).toEqual([
      expect.objectContaining({ notification_id: expect.stringContaining('notify:review_update:'), delivered_to_input_id: `planner:${goal.id}:1` }),
    ]);
  });

  it('returns null for an unknown recipient literal', () => {
    expect(resolveRecipient(projectRoot, store, 'missing-recipient')).toBeNull();
  });
});
