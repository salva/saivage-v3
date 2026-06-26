import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { CardActor, PlanningCardProcessorActor, readActorSnapshots, type CardActivationInput, type CardActivationOutcome, type CardProcessorActor, type LLMProviderPort } from '../../../src/runtime/actors/index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import type { LlmCompleteResult } from '../../../src/agents/llm-contracts.js';
import type { CardRecord } from '../../../src/schemas/index.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-planning-processor-'));
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

function markDone(store: CardStore, card: CardRecord): CardRecord {
  return store.commitTerminalLifecyclePatch(card.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'planner_done', summary: `${card.id} done` }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
}

function markFailed(store: CardStore, card: CardRecord): CardRecord {
  return store.commitTerminalLifecyclePatch(card.id, { status: 'failed', lifecycle: { status: 'failed', result: { kind: 'planner_failure', error: `${card.id} failed` }, error: `${card.id} failed`, completed_at: '2026-06-12T00:00:00.000Z' } });
}

function terminalProcessor(outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>): CardProcessorActor {
  return { activate: jest.fn(async () => outcome) as (input: CardActivationInput) => Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>> };
}

function noopNotificationDelivery() {
  return { hasPendingNotifications: () => false, deliverNotificationsForInput: () => [] };
}

function plannerResult(status: 'done' | 'blocked' | 'continue', summary: string) {
  return {
    kind: 'tool_calls' as const,
    tool_calls: [{ id: `planner-${status}`, type: 'function' as const, function: { name: 'emit_planner_result', arguments: JSON.stringify({ status, summary, blocked_reason: status === 'blocked' ? summary : undefined }) } }],
  };
}

function reviewerResult(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'tool_calls' as const,
    tool_calls: [{ id: 'reviewer-result-1', type: 'function' as const, function: { name: 'emit_reviewer_result', arguments: JSON.stringify({ assessment: { result: 'pass', summary: 'review ok', achieved: ['planned'], issues: [], evidence_card_ids: ['card-1'], ...overrides } }) } }],
  };
}

async function eventually(assertion: () => void, attempts = 40): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try { assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  throw lastError;
}

describe('PlanningCardProcessorActor', () => {
  it('delivers pending notifications in the planner turn context', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => input.role === 'reviewer' ? reviewerResult({ evidence_card_ids: [child.id] }) : plannerResult('done', 'done')) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const delivery = { deliverNotificationsForInput: jest.fn(() => [{ id: 'n1', message: 'Cancellation requested: stop', created_at: '2026-06-12T00:00:00.000Z' }]) };
    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery });

    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok', result: { kind: 'reviewer_pass', planning: { kind: 'planner_done', summary: 'done' } } });
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      role: 'planner',
      contextMessages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Cancellation requested: stop' }),
      ]),
      terminalToolNames: ['emit_planner_result'],
      tools: expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'emit_planner_result' }) })]),
    }), expect.any(AbortSignal));
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      agentId: `reviewer:${project.id}`,
      role: 'reviewer',
      sessionId: `reviewer:${project.id}:assessment-${project.id}-1`,
      terminalToolNames: ['emit_reviewer_result'],
      tools: expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'emit_reviewer_result' }) })]),
    }), expect.any(AbortSignal));
  }));

  it('persists active reconstruction during planning processor activation and clears it on settlement', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    let finish!: () => void;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => input.role === 'reviewer'
      ? reviewerResult({ evidence_card_ids: [child.id] })
      : new Promise<LlmCompleteResult>((resolve) => { finish = () => resolve(plannerResult('done', 'done')); })) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const pending = actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });
    await eventually(() => expect(actor.state()).toBe('planning'));
    expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === 'processor:project')?.context.active_reconstruction).toMatchObject({
      schema_version: 1,
      kind: 'processor_activation',
      processor_kind: 'planning',
      card_id: 'project',
      caller: { kind: 'root' },
      activation_counter: 1,
    });

    finish();
    await expect(pending).resolves.toMatchObject({ status: 'done' });
    await eventually(() => expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === 'processor:project')?.context.active_reconstruction).toBeNull());
  }));

  it('activates only immediate children and returns the child result to the planner', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const goal = createGoal(store);
    const childActor = CardActor.fromCard({ projectRoot, card: goal, store, processor: terminalProcessor({ status: 'done', summary: 'child done', result: { kind: 'planner_done', summary: 'child done' } }) });
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => input.role === 'reviewer'
        ? reviewerResult({ evidence_card_ids: [goal.id] })
        : input.episodeContext.lastToolResult
        ? plannerResult('done', 'project done')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: goal.id }) } }] }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: (id) => id === goal.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok', result: { kind: 'reviewer_pass', planning: { kind: 'planner_done', summary: 'project done' } } });
    expect(store.read(goal.id)?.status).toBe('done');
    expect(provider.completeTurn).toHaveBeenCalledTimes(3);
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: expect.objectContaining({ outcome: 'done', card_id: goal.id }) }) }),
    }), expect.any(AbortSignal));
  }));

  it('creates a planner child and activates it in the same planning activation', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    let createdId = '';
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        if (input.role === 'reviewer') return reviewerResult({ evidence_card_ids: [createdId] });
        const lastToolResult = (input.episodeContext.lastToolResult as { result?: { card?: { id: string }; outcome?: string } } | undefined)?.result;
        if (!lastToolResult) {
          return { kind: 'tool_calls' as const, tool_calls: [{ id: 'create-1', type: 'function' as const, function: { name: 'create_card', arguments: JSON.stringify({ type: 'code', parent: 'ignored-parent', title: 'Implement slice', description: 'Build the slice', acceptance: 'Slice works' }) } }] };
        }
        if (lastToolResult.card) {
          createdId = lastToolResult.card.id;
          return { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: createdId }) } }] };
        }
        if (lastToolResult.outcome === 'done') return plannerResult('done', 'project done');
        throw new Error(`Unexpected last tool result ${JSON.stringify(lastToolResult)}`);
      }),
    };
    const children = {
      get: jest.fn((id: string) => {
        const card = store.read(id);
        return card ? CardActor.fromCard({ projectRoot, card, store, processor: terminalProcessor({ status: 'done', summary: 'child done', result: { kind: 'planner_done', summary: 'child done' } }) }) : null;
      }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    const created = store.read(createdId);
    expect(created).toMatchObject({ type: 'code', parent: project.id, status: 'done', title: 'Implement slice', created_by: 'planner', acceptance: 'Slice works' });
    expect(children.get).toHaveBeenCalledWith(createdId);
    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok', result: { kind: 'reviewer_pass', planning: { kind: 'planner_done', summary: 'project done' } } });
    expect(provider.completeTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({
      tools: expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: 'create_card' }) }),
        expect.objectContaining({ function: expect.objectContaining({ name: 'activate_card' }) }),
      ]),
    }), expect.any(AbortSignal));
  }));

  it('returns planner create_card project attempts as recoverable tool errors', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'project create rejected')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'create-project-1', type: 'function' as const, function: { name: 'create_card', arguments: JSON.stringify({ type: 'project', title: 'bad' }) } }] }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'project create rejected' });
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: { success: false, error: 'create_card cannot create project cards.' } }) }),
    }), expect.any(AbortSignal));
  }));

  it('returns unsupported planner tools as recoverable tool errors', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'unsupported rejected')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'unsupported-1', type: 'function' as const, function: { name: 'restart_card', arguments: JSON.stringify({ card_id: project.id }) } }] }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'unsupported rejected' });
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: { success: false, error: "Unsupported planner tool call 'restart_card'." } }) }),
    }), expect.any(AbortSignal));
  }));

  it('returns malformed activate_card arguments as a recoverable tool result', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'tool args rejected')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: '' }) } }] }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'tool args rejected', result: { kind: 'planner_blocked' } });
    expect(provider.completeTurn).toHaveBeenCalledTimes(2);
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: { success: false, error: 'activate_card requires card_id.' } }) }),
    }), expect.any(AbortSignal));
  }));

  it('returns failed child activation as a recoverable tool result', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const failedGoal = markFailed(store, createGoal(store));
    const childActor = CardActor.fromCard({ projectRoot, card: failedGoal, store, processor: terminalProcessor({ status: 'done', summary: 'not invoked', result: { kind: 'planner_done', summary: 'not invoked' } }) });
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'child activation failed')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: failedGoal.id }) } }] }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: (id) => id === failedGoal.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'child activation failed', result: { kind: 'planner_blocked' } });
    expect(store.read(failedGoal.id)?.status).toBe('failed');
    expect(provider.completeTurn).toHaveBeenCalledTimes(2);
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      episodeContext: expect.objectContaining({
        lastToolResult: expect.objectContaining({
          result: { success: false, error: `Card '${failedGoal.id}' in status 'failed' is not activatable.`, card_id: failedGoal.id },
        }),
      }),
    }), expect.any(AbortSignal));
  }));

  it('rejects old activate_card cardId alias instead of normalizing it', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'alias rejected')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ cardId: 'old-alias' }) } }] }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'alias rejected' });
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: { success: false, error: 'activate_card requires card_id.' } }) }),
    }), expect.any(AbortSignal));
  }));

  it('delivers card notifications to planner continuation turns by input id', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const goal = createGoal(store);
    const childActor = CardActor.fromCard({ projectRoot, card: goal, store, processor: terminalProcessor({ status: 'done', summary: 'child done', result: { kind: 'planner_done', summary: 'child done' } }) });
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => input.role === 'reviewer'
        ? reviewerResult({ evidence_card_ids: [goal.id] })
        : input.episodeContext.lastToolResult
        ? plannerResult('done', 'project done')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: goal.id }) } }] }),
    };
    const delivery = { deliverNotificationsForInput: jest.fn((inputId: string) => inputId.endsWith(':tool:1') ? [{ id: 'n-mid', message: 'mid-turn notice', created_at: '2026-06-12T00:00:00.000Z' }] : []) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: (id) => id === goal.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery });

    expect(outcome).toMatchObject({ status: 'done' });
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith('planner:project:1');
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith('planner:project:1:tool:1');
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      contextMessages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'mid-turn notice' }),
      ]),
    }), expect.any(AbortSignal));
  }));

  it('does not drain main-agent notifications into reviewer turns', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => input.role === 'reviewer' ? reviewerResult({ evidence_card_ids: [child.id] }) : plannerResult('done', 'done')) };
    const delivery = { hasPendingNotifications: jest.fn(() => false), deliverNotificationsForInput: jest.fn(() => []) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery });

    expect(outcome).toMatchObject({ status: 'done' });
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledTimes(1);
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith('planner:project:1');
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ role: 'reviewer', contextMessages: [], systemPrompt: expect.stringContaining('Acceptance:') }), expect.any(AbortSignal));
  }));

  it('blocks reviewer approval when main-agent notifications arrive during review', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    const delivery = { hasPendingNotifications: jest.fn(() => false), deliverNotificationsForInput: jest.fn(() => []) };
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        if (input.role === 'reviewer') {
          delivery.hasPendingNotifications.mockReturnValue(true);
          return reviewerResult({ evidence_card_ids: [child.id] });
        }
        return plannerResult('done', 'done');
      }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery });

    expect(outcome).toMatchObject({ status: 'blocked', result: { kind: 'planner_blocked', reviewer_correction: { kind: 'reviewer_correction' } } });
    expect(outcome.summary).toContain('pending card notifications');
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledTimes(1);
  }));

  it('returns blocked reviewer correction when planner-owned review asks for corrections', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => input.role === 'reviewer' ? reviewerResult({ result: 'needs_corrections', summary: 'fix it', issues: [{ summary: 'missing proof', severity: 'blocker' }], evidence_card_ids: [child.id] }) : plannerResult('done', 'done')) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'fix it', result: { kind: 'planner_blocked', reviewer_correction: { kind: 'reviewer_correction', summary: 'fix it' } } });
  }));

  it('invokes reviewer for goal done outcomes', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const goal = createGoal(store);
    const child = markDone(store, createGoal(store, goal.id));
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => input.role === 'reviewer' ? reviewerResult({ evidence_card_ids: [child.id] }) : plannerResult('done', 'goal done')) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: goal.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: goal, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'done', result: { kind: 'reviewer_pass', planning: { kind: 'planner_done', summary: 'goal done' } } });
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ agentId: `reviewer:${goal.id}`, role: 'reviewer', sessionId: `reviewer:${goal.id}:assessment-${goal.id}-1` }), expect.any(AbortSignal));
  }));

  it('blocks planner done when planner-owned reviewer cites invalid evidence', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => input.role === 'reviewer' ? reviewerResult({ evidence_card_ids: ['missing'] }) : plannerResult('done', 'done')) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', result: { kind: 'planner_blocked', reviewer_correction: { kind: 'reviewer_correction' } } });
    expect(outcome.summary).toContain('missing');
  }));

  it('blocks planner done when reviewer cites only the reviewed card candidate result', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => input.role === 'reviewer' ? reviewerResult({ evidence_card_ids: [project.id] }) : plannerResult('done', 'done')) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', result: { kind: 'planner_blocked', reviewer_correction: { kind: 'reviewer_correction' } } });
    expect(outcome.summary).toContain('without durable result');
  }));

  it('blocks done reports while descendants remain incomplete', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const goal = createGoal(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => plannerResult('done', 'project done')) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', result: { kind: 'planner_blocked' } });
    expect(outcome.summary).toContain(goal.id);
    expect(provider.completeTurn).toHaveBeenCalledTimes(1);
  }));

  it('does not invoke reviewer for blocked or continue planner outcomes', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => plannerResult('blocked', 'blocked')) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const blocked = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });
    provider.completeTurn = jest.fn(async () => plannerResult('continue', 'continue'));
    const continued = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(blocked).toMatchObject({ status: 'blocked', result: { kind: 'planner_blocked' } });
    expect(continued).toMatchObject({ status: 'blocked', result: { kind: 'planner_blocked', blocker_cause: 'non_actionable_continue' } });
    expect(provider.completeTurn).toHaveBeenCalledTimes(1);
  }));

  it('accepts a terminal planner result produced by the final allowed tool append', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    let plannerTurns = 0;
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        if (input.role === 'reviewer') return reviewerResult({ evidence_card_ids: [] });
        plannerTurns++;
        if (plannerTurns <= 20) return { kind: 'tool_calls' as const, tool_calls: [{ id: `activate-${plannerTurns}`, type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: '' }) } }] };
        return plannerResult('blocked', 'blocked at boundary');
      }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'blocked at boundary', result: { kind: 'planner_blocked' } });
    expect(plannerTurns).toBe(21);
    expect(provider.completeTurn).toHaveBeenCalledTimes(21);
  }));

  it('fails the planner budget when the final allowed tool append is non-terminal', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    let plannerTurns = 0;
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async () => {
        plannerTurns++;
        return { kind: 'tool_calls' as const, tool_calls: [{ id: `activate-${plannerTurns}`, type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: '' }) } }] };
      }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'failed', summary: 'Planner exceeded turn budget.', result: { kind: 'planner_failure', error: 'Planner exceeded turn budget.' } });
    expect(plannerTurns).toBe(21);
  }));

  it('does not accept plain reviewer message JSON as terminal assessment', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => input.role === 'reviewer' ? { kind: 'message' as const, content: JSON.stringify({ result: 'pass', summary: 'ok', achieved: ['planned'], issues: [], evidence_card_ids: [project.id] }) } : plannerResult('done', 'done')) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'failed', result: { kind: 'planner_failure' } });
    expect(outcome.summary).toContain('emit_reviewer_result');
  }));

  it('does not accept plain planner message JSON as terminal result', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: JSON.stringify({ status: 'done', summary: 'done' }) })) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'failed', result: { kind: 'planner_failure' } });
    expect(outcome.summary).toContain('emit_planner_result');
  }));

  it('throws a clear impossible-state error when recovering directly into planning', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider: { completeTurn: jest.fn(async () => plannerResult('blocked', 'unused')) } });

    expect(() => actor.recover('planning')).toThrow(/cannot recover directly into active state 'planning'/);
  }));
});
