import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { PlanningCardProcessorActor, type CardActivationInput, type LLMProviderPort, type LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import { readRecordSlotIndex } from '../../../src/runtime/records/record-slots.js';
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
        if (!lastToolResult) return toolCall('planner-write', 'write', { path: 'record:///status.md?v=next', content: 'planner status' });
        return plannerDone();
      }
      if (!lastToolResult) {
        reviewerAttempt++;
        return toolCall(`reviewer-write-${reviewerAttempt}`, 'write', { path: 'record:///review.md?v=next', content: `review ${reviewerAttempt}` });
      }
      if (!mutatedDuringReview) {
        mutatedDuringReview = true;
        store.mutateCard(project.id, { priority: project.priority + 1 }, { actor: 'planner', surface: 'runtime', reason: 'test stale review' });
      }
      return reviewerPass(`reviewer-pass-${reviewerAttempt}`, child.id);
    }) };
    const actor = new PlanningCardProcessorActor({ projectRoot, promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate(activateInput(project), new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok' });
    expect(reviewerAttempt).toBe(2);
    const index = readRecordSlotIndex(projectRoot, project.id, 'review');
    expect(index.latest).toBe(2);
    expect(index.versions['1']).toMatchObject({ status: 'discarded', reason: 'stale_review' });
    expect(index.versions['2']).toMatchObject({ status: 'closed' });
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
        if (!lastToolResult) return toolCall('planner-write', 'write', { path: 'record:///status.md?v=next', content: 'planner status' });
        return plannerDone();
      }
      if (!lastToolResult) {
        reviewerAttempt++;
        return toolCall(`reviewer-write-${reviewerAttempt}`, 'write', { path: 'record:///review.md?v=next', content: `review ${reviewerAttempt}` });
      }
      notificationArrivedDuringReview = true;
      return reviewerPass(`reviewer-pass-${reviewerAttempt}`, child.id);
    }) };
    const actor = new PlanningCardProcessorActor({ projectRoot, promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
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
    const index = readRecordSlotIndex(projectRoot, project.id, 'review');
    expect(index.versions['1']).toMatchObject({ status: 'closed' });
    expect(index.latest).toBe(1);
  }));

  it('repairs a missing review file in the same reviewer session before currentness acceptance', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => {
      const lastToolResult = input.episodeContext.lastToolResult as { toolName?: string } | undefined;
      if (input.role === 'planner') {
        if (!lastToolResult) return toolCall('planner-write', 'write', { path: 'record:///status.md?v=next', content: 'planner status' });
        return plannerDone();
      }
      if (!lastToolResult) return reviewerPass('reviewer-pass-missing-file', child.id);
      if (lastToolResult.toolName === 'emit_result') return toolCall('reviewer-write-repair', 'write', { path: 'record:///review.md?v=next', content: 'repaired review' });
      return reviewerPass('reviewer-pass-repaired', child.id);
    }) };
    const actor = new PlanningCardProcessorActor({ projectRoot, promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate(activateInput(project), new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok' });
    const index = readRecordSlotIndex(projectRoot, project.id, 'review');
    expect(index.latest).toBe(1);
    expect(index.versions['1']).toMatchObject({ status: 'closed' });
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
        if (!lastToolResult) return toolCall('planner-write', 'write', { path: 'record:///status.md?v=next', content: 'planner status' });
        return plannerDone();
      }
      if (!lastToolResult) {
        reviewerAttempt++;
        return toolCall(`reviewer-write-${reviewerAttempt}`, 'write', { path: 'record:///review.md?v=next', content: `review ${reviewerAttempt}` });
      }
      store.mutateCard(project.id, { priority: project.priority + reviewerAttempt }, { actor: 'planner', surface: 'runtime', reason: 'test stale review budget' });
      return reviewerPass(`reviewer-pass-${reviewerAttempt}`, child.id);
    }) };
    const actor = new PlanningCardProcessorActor({ projectRoot, promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate(activateInput(project), new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'failed', result: { kind: 'failed' } });
    expect(outcome.summary).toContain('Reviewer currentness relaunch budget exhausted');
    expect(reviewerAttempt).toBe(3);
    const index = readRecordSlotIndex(projectRoot, project.id, 'review');
    expect(index.latest).toBeNull();
    expect(index.versions['1']).toMatchObject({ status: 'discarded', reason: 'stale_review' });
    expect(index.versions['2']).toMatchObject({ status: 'discarded', reason: 'stale_review' });
    expect(index.versions['3']).toMatchObject({ status: 'discarded', reason: 'stale_review' });
  }));
});
