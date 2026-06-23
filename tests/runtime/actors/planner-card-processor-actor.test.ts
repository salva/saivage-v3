import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { CardActor, PlannerCardProcessorActor, type CardActivationInput, type CardActivationOutcome, type CardProcessorActor, type LLMProviderPort } from '../../../src/runtime/actors/index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import type { CardRecord } from '../../../src/schemas/index.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-planner-processor-'));
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

function terminalProcessor(outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>): CardProcessorActor {
  return { activate: jest.fn(async () => outcome) as (input: CardActivationInput, signal: AbortSignal) => Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>> };
}

function plannerResult(status: 'done' | 'blocked' | 'continue', summary: string) {
  return {
    kind: 'tool_calls' as const,
    tool_calls: [{ id: `planner-${status}`, type: 'function' as const, function: { name: 'emit_planner_result', arguments: JSON.stringify({ status, summary, blocked_reason: status === 'blocked' ? summary : undefined }) } }],
  };
}

describe('PlannerCardProcessorActor', () => {
  it('delivers pending notifications in the planner turn context', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => plannerResult('done', 'done')) };
    const actor = new PlannerCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notifications: [{ id: 'n1', message: 'Cancellation requested: stop', created_at: '2026-06-12T00:00:00.000Z' }] });

    expect(outcome).toMatchObject({ status: 'done', summary: 'done' });
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      contextMessages: [{ role: 'user', content: 'Cancellation requested: stop' }],
      terminalToolNames: ['emit_planner_result'],
      tools: expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'emit_planner_result' }) })]),
    }), expect.any(AbortSignal));
  }));

  it('activates only immediate children and returns the child result to the planner', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const goal = createGoal(store);
    const childActor = CardActor.fromCard({ projectRoot, card: goal, store, processor: terminalProcessor({ status: 'done', summary: 'child done', result: { kind: 'planner_done', summary: 'child done' } }) });
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('done', 'project done')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: goal.id }) } }] }),
    };
    const actor = new PlannerCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: (id) => id === goal.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notifications: [] });

    expect(outcome).toMatchObject({ status: 'done', summary: 'project done' });
    expect(store.read(goal.id)?.status).toBe('done');
    expect(provider.completeTurn).toHaveBeenCalledTimes(2);
    expect(provider.completeTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: expect.objectContaining({ outcome: 'done', card_id: goal.id }) }) }),
    }), expect.any(AbortSignal));
  }));

  it('delivers card notifications to planner continuation turns by input id', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const goal = createGoal(store);
    const childActor = CardActor.fromCard({ projectRoot, card: goal, store, processor: terminalProcessor({ status: 'done', summary: 'child done', result: { kind: 'planner_done', summary: 'child done' } }) });
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('done', 'project done')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: goal.id }) } }] }),
    };
    const delivery = { deliverNotificationsForInput: jest.fn((inputId: string) => inputId.endsWith(':tool:1') ? [{ id: 'n-mid', message: 'mid-turn notice', created_at: '2026-06-12T00:00:00.000Z' }] : []) };
    const actor = new PlannerCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: (id) => id === goal.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notifications: [], notificationDelivery: delivery });

    expect(outcome).toMatchObject({ status: 'done' });
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith('planner:project:1');
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith('planner:project:1:tool:1');
    expect(provider.completeTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      contextMessages: [{ role: 'user', content: 'mid-turn notice' }],
    }), expect.any(AbortSignal));
  }));

  it('blocks done reports while descendants remain incomplete', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const goal = createGoal(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => plannerResult('done', 'project done')) };
    const actor = new PlannerCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notifications: [] });

    expect(outcome).toMatchObject({ status: 'blocked', result: { kind: 'planner_blocked' } });
    expect(outcome.summary).toContain(goal.id);
  }));

  it('does not accept plain planner message JSON as terminal result', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: JSON.stringify({ status: 'done', summary: 'done' }) })) };
    const actor = new PlannerCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notifications: [] });

    expect(outcome).toMatchObject({ status: 'failed', result: { kind: 'planner_failure' } });
    expect(outcome.summary).toContain('emit_planner_result');
  }));
});
