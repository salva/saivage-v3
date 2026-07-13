import { initProjectTree, CardStore } from '../../helpers/canonical-project.js';
import { testActorSnapshots } from '../../helpers/actor-snapshots.js';
import { describe, expect, it, jest } from '@jest/globals';
import { testConversationMutations } from '../../helpers/conversation-mutations.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { type CardActivationInput, type LLMProviderPort, type LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import { TestPlanningCardProcessorActor as PlanningCardProcessorActor } from '../../helpers/app-log-actors.js';
import type { LlmCompleteResult, ProviderTurnCompletion } from '../../../src/agents/llm-contracts.js';

import type { CardRecord } from '../../../src/schemas/index.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-review-currentness-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function createProject(store: CardStore): CardRecord {
  const project = store.read('project');
  if (!project) throw new Error('project card not found');
  return project;
}

function createGoal(store: CardStore, parent: string): CardRecord {
  return store.create({ type: 'goal', parent, depth: 1, title: 'goal', brief: 'goal', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
}

function markDone(store: CardStore, card: CardRecord): CardRecord {
  return store.commitTerminalLifecyclePatch(card.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: `${card.id} done` }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { kind: 'tool_calls' as const, tool_calls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] };
}

function plannerDone(id = 'planner-done') {
  return toolCall(id, 'emit_result', { status: 'done', summary: 'planner done' });
}

function reviewerPass(id: string, evidenceCardId: string) {
  void evidenceCardId;
  return toolCall(id, 'emit_result', { status: 'done', summary: 'review ok' });
}

function providerCompletion(result: LlmCompleteResult): ProviderTurnCompletion {
  return { result, provider_exchanges: [] };
}

function activateInput(card: CardRecord, notificationDelivery: CardActivationInput['notificationDelivery'] = { deliverNotificationsForInput: () => [] }): CardActivationInput {
  return { card, caller: { kind: 'root' }, notificationDelivery };
}

describe('PlanningCardProcessorActor reviewer currentness', () => {
  it('discards a stale review slot and relaunches when reviewed card versions change', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    let reviewerAttempt = 0;
    let mutatedDuringReview = false;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => {
      const lastToolResult = input.episodeContext.lastToolResult as { toolName?: string } | undefined;
      if (input.role === 'planner') {
        if (!lastToolResult) return providerCompletion(toolCall('planner-write', 'write', { path: 'record:///status.md?v=next', content: 'planner status' }));
        return providerCompletion(plannerDone());
      }
      if (!lastToolResult) {
        reviewerAttempt++;
        return providerCompletion(toolCall(`reviewer-write-${reviewerAttempt}`, 'write', { path: 'record:///review.md?v=next', content: `review ${reviewerAttempt}` }));
      }
      if (!mutatedDuringReview) {
        mutatedDuringReview = true;
        store.mutateCard(project.id, { priority: project.priority + 1 }, { actor: 'planner', surface: 'runtime', reason: 'test stale review' });
      }
      return providerCompletion(reviewerPass(`reviewer-pass-${reviewerAttempt}`, child.id));
    }) };
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate(activateInput(project), new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok' });
    expect(reviewerAttempt).toBe(2);
    const slot = store.recordReader.generation().cards.get(project.id)!.records.review;
    expect(slot.latest?.version).toBe(2);
    expect(slot.artifacts.find(({ version }) => version === 1)).toMatchObject({ state: 'discarded', reason: 'stale_review' });
    expect(slot.artifacts.find(({ version }) => version === 2)).toMatchObject({ state: 'closed' });
  }));

  it('does not use pending notification state or reviewer notification context as reviewer currentness', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    let reviewerAttempt = 0;
    let notificationArrivedDuringReview = false;
    const delivery = { deliverNotificationsForInput: jest.fn(() => []) };
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => {
      const lastToolResult = input.episodeContext.lastToolResult as { toolName?: string } | undefined;
      if (input.role === 'planner') {
        if (!lastToolResult) return providerCompletion(toolCall('planner-write', 'write', { path: 'record:///status.md?v=next', content: 'planner status' }));
        return providerCompletion(plannerDone());
      }
      if (!lastToolResult) {
        reviewerAttempt++;
        return providerCompletion(toolCall(`reviewer-write-${reviewerAttempt}`, 'write', { path: 'record:///review.md?v=next', content: `review ${reviewerAttempt}` }));
      }
      notificationArrivedDuringReview = true;
      return providerCompletion(reviewerPass(`reviewer-pass-${reviewerAttempt}`, child.id));
    }) };
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate(activateInput(project, delivery), new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok' });
    expect(notificationArrivedDuringReview).toBe(true);
    expect(reviewerAttempt).toBe(1);
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith('planner:project:1');
    expect(delivery.deliverNotificationsForInput).not.toHaveBeenCalledWith(expect.stringMatching(/^reviewer:/));
    const reviewerInputs = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls.map(([input]) => input).filter((input) => input.role === 'reviewer');
    expect(reviewerInputs).toHaveLength(2);
    for (const reviewerInput of reviewerInputs) {
      const contextText = JSON.stringify(reviewerInput.contextMessages);
      expect(contextText).not.toContain('pending main-agent notifications');
      expect(contextText).not.toContain('Pending main-agent notifications');
      expect(contextText).not.toContain('notification-currentness');
      expect(contextText).not.toContain('invalidation signal');
    }
    const slot = store.recordReader.generation().cards.get(project.id)!.records.review;
    expect(slot.artifacts.find(({ version }) => version === 1)).toMatchObject({ state: 'closed' });
    expect(slot.latest?.version).toBe(1);
  }));

  it('repairs a missing review file in the same reviewer session before currentness acceptance', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => {
      const lastToolResult = input.episodeContext.lastToolResult as { toolName?: string } | undefined;
      if (input.role === 'planner') {
        if (!lastToolResult) return providerCompletion(toolCall('planner-write', 'write', { path: 'record:///status.md?v=next', content: 'planner status' }));
        return providerCompletion(plannerDone());
      }
      if (!lastToolResult) return providerCompletion(reviewerPass('reviewer-pass-missing-file', child.id));
      if (lastToolResult.toolName === 'emit_result') return providerCompletion(toolCall('reviewer-write-repair', 'write', { path: 'record:///review.md?v=next', content: 'repaired review' }));
      return providerCompletion(reviewerPass('reviewer-pass-repaired', child.id));
    }) };
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate(activateInput(project), new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok' });
    const slot = store.recordReader.generation().cards.get(project.id)!.records.review;
    expect(slot.latest?.version).toBe(1);
    expect(slot.artifacts.find(({ version }) => version === 1)).toMatchObject({ state: 'closed' });
  }));

  it('fails after the stale-review relaunch budget is exhausted', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    let reviewerAttempt = 0;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => {
      const lastToolResult = input.episodeContext.lastToolResult as { toolName?: string } | undefined;
      if (input.role === 'planner') {
        if (!lastToolResult) return providerCompletion(toolCall('planner-write', 'write', { path: 'record:///status.md?v=next', content: 'planner status' }));
        return providerCompletion(plannerDone());
      }
      if (!lastToolResult) {
        reviewerAttempt++;
        return providerCompletion(toolCall(`reviewer-write-${reviewerAttempt}`, 'write', { path: 'record:///review.md?v=next', content: `review ${reviewerAttempt}` }));
      }
      store.mutateCard(project.id, { priority: project.priority + reviewerAttempt }, { actor: 'planner', surface: 'runtime', reason: 'test stale review budget' });
      return providerCompletion(reviewerPass(`reviewer-pass-${reviewerAttempt}`, child.id));
    }) };
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate(activateInput(project), new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'failed', result: { kind: 'failed' } });
    expect(outcome.summary).toContain('Reviewer currentness relaunch budget exhausted');
    expect(reviewerAttempt).toBe(3);
    const slot = store.recordReader.generation().cards.get(project.id)!.records.review;
    expect(slot.latest).toBeNull();
    for (const version of [1, 2, 3]) expect(slot.artifacts.find((artifact) => artifact.version === version)).toMatchObject({ state: 'discarded', reason: 'stale_review' });
  }));
});
