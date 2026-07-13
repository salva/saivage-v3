import { initProjectTree, CardStore } from '../../helpers/canonical-project.js';
import { testActorSnapshots } from '../../helpers/actor-snapshots.js';
import { describe, expect, it, jest } from '@jest/globals';
import { testConversationMutations } from '../../helpers/conversation-mutations.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { CardActor, PlanningCardProcessorActor, readActorSnapshots, type CardActivationInput, type CardActivationOutcome, type CardActorDeps, type CardProcessorActor, type LLMProviderPort } from '../../../src/runtime/actors/index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import { ProviderTurnFailure, type LlmCompleteResult, type ProviderTurnCompletion } from '../../../src/agents/llm-contracts.js';
import type { CardRecord } from '../../../src/schemas/index.js';

import { ProcessRunner } from '../../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { readConversationMessages } from '../../../src/runtime/actors/conversation-store.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-planning-processor-'));
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

function createGoal(store: CardStore, parent = 'project'): CardRecord {
  return store.create({ type: 'goal', parent, depth: parent === 'project' ? 1 : 2, title: 'goal', brief: 'goal', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
}

function createCode(store: CardStore, parent = 'project'): CardRecord {
  return store.create({ type: 'code', parent, depth: parent === 'project' ? 1 : 2, title: 'code', brief: 'code', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
}

function writeBrief(store: CardStore, cardId: string, content: string, cardVersionSeq = 1): void {
  const slot = store.openRecord(cardId, 'brief.md');
  store.editRecord(cardId, 'brief.md', slot.version, content);
  store.closeRecord(cardId, 'brief.md', slot.version, 'planner', cardVersionSeq);
}

function markDone(store: CardStore, card: CardRecord): CardRecord {
  return store.commitTerminalLifecyclePatch(card.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: `${card.id} done` }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
}

function markFailed(store: CardStore, card: CardRecord): CardRecord {
  return store.commitTerminalLifecyclePatch(card.id, { status: 'failed', lifecycle: { status: 'failed', result: { kind: 'failed', summary: `${card.id} failed` }, error: `${card.id} failed`, completed_at: '2026-06-12T00:00:00.000Z' } });
}

function markBlocked(store: CardStore, card: CardRecord): CardRecord {
  return store.commitTerminalLifecyclePatch(card.id, { status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'blocked', summary: `${card.id} blocked`, resume_reason: 'test' }, error: `${card.id} blocked`, completed_at: null } });
}

function terminalProcessor(outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>): CardProcessorActor {
  return { activate: jest.fn(async () => outcome) as (input: CardActivationInput) => Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>, disposeActivation: jest.fn(), joinActivation: jest.fn(async () => []), pendingJoinTaskCount: jest.fn(() => 0) };
}

function cardActorDeps(projectRoot: string, store: CardStore): CardActorDeps {
  return { projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), store, provider: { completeTurn: jest.fn() as never }, promptTemplates: createTestPromptTemplateRegistry(), processRunner: createTestProcessRunner(projectRoot), notifyCard: () => ({ ok: true }), lookup: new Map() };
}

function makeChildActor(projectRoot: string, store: CardStore, card: CardRecord, processor: CardProcessorActor): CardActor {
  const actor = CardActor.fromCard({ card, deps: cardActorDeps(projectRoot, store) });
  Object.defineProperty(actor, 'processor', { value: processor });
  return actor;
}

function noopNotificationDelivery() {
  return { deliverNotificationsForInput: () => [] };
}

function plannerResult(status: 'done' | 'blocked' | 'failed', summary: string) {
  return plannerResultWithCallId(status, summary, `planner-${status}`);
}

function plannerResultWithCallId(status: 'done' | 'blocked' | 'failed', summary: string, callId: string) {
  return {
    kind: 'tool_calls' as const,
    tool_calls: [{ id: callId, type: 'function' as const, function: { name: 'emit_result', arguments: JSON.stringify({ status, summary }) } }],
  };
}

function reviewerResult(overrides: { status?: 'done' | 'rework' | 'blocked' | 'failed'; summary?: string } = {}) {
  const status = overrides.status ?? 'done';
  const summary = typeof overrides.summary === 'string' ? overrides.summary : 'review ok';
  return {
    kind: 'tool_calls' as const,
    tool_calls: [{ id: 'reviewer-result-1', type: 'function' as const, function: { name: 'emit_result', arguments: JSON.stringify({ status, summary }) } }],
  };
}

function recordWrite(callId: string, path: string, content: string) {
  return {
    kind: 'tool_calls' as const,
    tool_calls: [{ id: callId, type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({ path, content }) } }],
  };
}

function providerCompletion(result: LlmCompleteResult): ProviderTurnCompletion {
  return { result, provider_exchanges: [] };
}

function invocationToolNames(input: LlmInvocationInput): string[] {
  return input.tools.map((tool) => tool.function.name).sort();
}

function capturedInput(provider: LLMProviderPort, role: 'planner' | 'reviewer'): LlmInvocationInput {
  const calls = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls;
  const input = calls.find(([candidate]) => candidate.role === role)?.[0];
  if (!input) throw new Error(`Missing ${role} invocation input`);
  return input;
}

function terminalToolResultError(input: LlmInvocationInput, toolCallId: string): string {
  const result = input.episodeContext.lastToolResult as { toolCallId?: string; result?: { error?: string } } | undefined;
  expect(result).toMatchObject({ toolCallId, result: { success: false, error: expect.any(String) } });
  return result?.result?.error ?? '';
}

function expectNotificationSeparatedFromTerminalError(error: string, notificationPayload: string): void {
  expect(error).not.toContain('Pending main-agent notifications');
  expect(error).not.toContain('notification');
  expect(error).not.toContain(notificationPayload);
}

function providerTurnFailure(message: string): ProviderTurnFailure {
  return new ProviderTurnFailure({ failure_phase: 'pre_provider', provider_exchanges: [], originalFailure: new Error(message) });
}

function withMandatoryRecords(responder: (input: LlmInvocationInput) => Promise<LlmCompleteResult | ProviderTurnCompletion> | LlmCompleteResult | ProviderTurnCompletion): LLMProviderPort {
  const pending = new Map<string, LlmCompleteResult>();
  const recordWrites = new Map<string, number>();
  return {
    completeTurn: jest.fn(async (input: LlmInvocationInput) => {
      const key = input.sessionId;
      const pendingTerminal = pending.get(key);
      if (pendingTerminal) {
        if (!input.episodeContext.lastToolResult) {
          pending.delete(key);
        } else {
          pending.delete(key);
          return providerCompletion(pendingTerminal);
        }
      }
      const completion = await responder(input);
      const result = 'result' in completion ? completion.result : completion;
      if (result.kind !== 'tool_calls') return providerCompletion(result);
      if (result.tool_calls.some((toolCall) => toolCall.function.name === 'emit_result') && input.role === 'planner') {
        pending.set(key, result);
        const count = (recordWrites.get(key) ?? 0) + 1;
        recordWrites.set(key, count);
        return providerCompletion(recordWrite(`status-${key}-${count}`, 'record:///status.md?v=next', `Status for ${input.episodeContext.cardId ?? key}`));
      }
      if (result.tool_calls.some((toolCall) => toolCall.function.name === 'emit_result') && input.role === 'reviewer') {
        pending.set(key, result);
        const count = (recordWrites.get(key) ?? 0) + 1;
        recordWrites.set(key, count);
        return providerCompletion(recordWrite(`review-${key}-${count}`, 'record:///review.md?v=next', `Review for ${input.episodeContext.cardId ?? key}`));
      }
      return providerCompletion(result);
    }),
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
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer' ? reviewerResult() : plannerResult('done', 'done'));
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const delivery = { deliverNotificationsForInput: jest.fn(() => [{ id: 'n1', message: 'Cancellation requested: stop', created_at: '2026-06-12T00:00:00.000Z' }]) };
    const outcome = await actor.activate({ activationId: `card:${project.id}:activation:test`, card: project, caller: { kind: 'root' }, notificationDelivery: delivery }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok', result: { kind: 'done', summary: 'review ok' } });
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      role: 'planner',
      contextMessages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Cancellation requested: stop' }),
      ]),
      terminalToolNames: ['emit_result'],
      systemPrompt: expect.stringContaining('record:///status.md?v=next'),
      tools: expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'emit_result' }) })]),
    }), expect.any(AbortSignal));
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      agentId: `reviewer:${project.id}`,
      role: 'reviewer',
      sessionId: `reviewer:${project.id}:assessment-${project.id}-1`,
      terminalToolNames: ['emit_result'],
      systemPrompt: expect.stringContaining('record:///review.md?v=next'),
      tools: expect.arrayContaining(['read', 'write', 'glob', 'grep', 'edit', 'list_card_history', 'get_card_history_entry', 'diff_card', 'websearch', 'webfetch', 'skill', 'mcp_tool_call', 'emit_result'].map((name) => expect.objectContaining({ function: expect.objectContaining({ name }) }))),
    }), expect.any(AbortSignal));

    const plannerToolNames = invocationToolNames(capturedInput(provider, 'planner'));
    expect(plannerToolNames).toEqual([
      'activate_card',
      'cancel_card',
      'create_card',
      'diff_card',
      'edit',
      'edit_card',
      'emit_result',
      'get_card',
      'get_card_history_entry',
      'get_tree',
      'glob',
      'grep',
      'list_card_history',
      'list_cards',
      'queue_notification',
      'read',
      'reorder_child',
      'webfetch',
      'websearch',
      'write',
    ].sort());
    expect(plannerToolNames).not.toEqual(expect.arrayContaining([
      'apply_patch',
      'run_command',
      'wait_process',
      'kill_process',
      'skill',
      'mcp_tool_call',
      'write_file',
      'terminate_process',
      'get_card_output',
      'restart_card_or_subtree',
      'restart_goal',
      'abort_goal_subtree',
      'mark_goal_needs_corrections',
      'create_plan',
      'update_plan',
    ]));

    const reviewerToolNames = invocationToolNames(capturedInput(provider, 'reviewer'));
    expect(reviewerToolNames).toEqual([
      'diff_card',
      'edit',
      'emit_result',
      'get_card_history_entry',
      'glob',
      'grep',
      'list_card_history',
      'mcp_tool_call',
      'read',
      'skill',
      'webfetch',
      'websearch',
      'write',
    ].sort());
    expect(reviewerToolNames).not.toEqual(expect.arrayContaining([
      'apply_patch',
      'run_command',
      'wait_process',
      'kill_process',
      'create_card',
      'edit_card',
      'activate_card',
      'cancel_card',
      'reorder_child',
      'queue_notification',
      'write_file',
      'terminate_process',
      'get_card_output',
      'restart_card_or_subtree',
      'restart_goal',
      'abort_goal_subtree',
      'mark_goal_needs_corrections',
      'create_plan',
      'update_plan',
    ]));
    const plannerConversation = readConversationMessages(projectRoot, `planner:${project.id}`);
    expect(plannerConversation).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'activity', role: 'system', content: expect.stringContaining('activation_open') }),
      expect.objectContaining({ kind: 'text', role: 'user', content: 'Cancellation requested: stop' }),
    ]));
    const removedSnapshotHeading = ['Current Planner', 'State Snapshot'].join(' ');
    expect(plannerConversation.some((message) => message.content.includes(removedSnapshotHeading))).toBe(false);
    expect(readConversationMessages(projectRoot, `reviewer:${project.id}:assessment-${project.id}-1`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'text', role: 'user', content: expect.stringContaining('Descendant work:') }),
    ]));
  }));

  it('loads the persisted planner prefix on a later idle activation without provider-visible activation markers', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider = withMandatoryRecords(() => plannerResult('blocked', 'blocked'));
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: { deliverNotificationsForInput: () => [{ id: 'n1', message: 'first-turn-note', created_at: '2026-06-12T00:00:00.000Z' }] } }, new AbortController().signal);
    await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    const plannerCalls = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls.map(([call]) => call).filter((call) => call.role === 'planner');
    const secondInitial = plannerCalls.find((call) => call.inputId === `planner:${project.id}:2`);
    if (!secondInitial) throw new Error('Missing second planner initial turn');
    expect(secondInitial.contextMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'text', role: 'user', content: 'first-turn-note' }),
    ]));
    expect(secondInitial.contextMessages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'activity' }),
    ]));
  }));

  it('builds planner and reviewer prompts from the latest brief record', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    writeBrief(store, project.id, '# Goal\n\nPlan from brief record.\n\n# Acceptance Criteria\n\nReview from brief record.\n', project.version_seq);
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
      if (input.role === 'reviewer') {
        expect(input.systemPrompt).toContain('Plan from brief record.');
        expect(input.systemPrompt).toContain('Review from brief record.');
        expect(input.systemPrompt).not.toContain('\n\nAcceptance:\n');
        return reviewerResult();
      }
      expect(input.systemPrompt).toContain('Plan from brief record.');
      expect(input.systemPrompt).toContain('Review from brief record.');
      expect(input.systemPrompt).not.toContain('\n\nAcceptance:\n');
      return plannerResult('done', 'done');
    });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok' });
  }));

  it('persists active reconstruction during planning processor activation and clears it on settlement', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    let finish!: () => void;
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer'
      ? reviewerResult()
      : new Promise<LlmCompleteResult>((resolve) => { finish = () => resolve(plannerResult('done', 'done')); }));
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const pending = actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);
    await eventually(() => expect(actor.state()).toBe('planning'));
    expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === 'processor:project')?.context.active_reconstruction).toMatchObject({
      schema_version: 1,
      kind: 'processor_activation',
      processor_kind: 'planning',
      card_id: 'project',
      caller: { kind: 'root' },
      activation_counter: 1,
    });
    await eventually(() => expect(finish).toEqual(expect.any(Function)));

    finish();
    await expect(pending).resolves.toMatchObject({ status: 'done' });
    await eventually(() => expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === 'processor:project')?.context.active_reconstruction).toBeNull());
  }));

  it('activates only immediate children and returns the child result to the planner', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const goal = createGoal(store);
    const childActor = makeChildActor(projectRoot, store, goal, terminalProcessor({ status: 'done', summary: 'child done', result: { kind: 'done', summary: 'child done' } }));
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer'
        ? reviewerResult()
        : input.episodeContext.lastToolResult
        ? plannerResult('done', 'project done')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: goal.id }) } }] });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: (id) => id === goal.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok', result: { kind: 'done', summary: 'review ok' } });
    expect(store.read(goal.id)?.status).toBe('done');
    expect(provider.completeTurn).toHaveBeenCalledTimes(5);
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: expect.objectContaining({ data: expect.objectContaining({ outcome: 'done', card_id: goal.id }) }) }) }),
    }), expect.any(AbortSignal));
  }));

  it('settles a real child provider-contract failure through its parent activate_card barrier', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = createCode(store, project.id);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const provider = withMandatoryRecords((turnInput: LlmInvocationInput) => {
      if (turnInput.role === 'executor') throw new Error('raw child provider rejection');
      if (turnInput.episodeContext.lastToolResult) return plannerResult('failed', 'child failed');
      return { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: child.id }) } }] };
    });
    const deps = { ...cardActorDeps(projectRoot, store), provider };
    const root = CardActor.fromCard({ card: project, deps });

    const outcome = await root.activate({ kind: 'root' });

    const strictError = `Provider boundary for 'terminal:${child.id}:1' failed without ProviderTurnFailure metadata.`;
    expect(outcome).toMatchObject({ status: 'failed', summary: 'child failed' });
    expect(store.read(child.id)).toMatchObject({ status: 'failed', lifecycle: { status: 'failed', error: strictError } });
    const plannerInputs = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls.map(([turnInput]) => turnInput).filter((turnInput) => turnInput.role === 'planner');
    expect(plannerInputs.filter((turnInput) => turnInput.episodeContext.lastToolResult).filter((turnInput) => JSON.stringify(turnInput.episodeContext.lastToolResult).includes(child.id))).toHaveLength(1);
    expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === `card:${child.id}`)?.context.active_reconstruction).toBeNull();
    expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === `processor:${child.id}`)?.context.active_reconstruction).toBeNull();
    expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === `executor:${child.id}`)?.context.active_reconstruction ?? null).toBeNull();
    expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === 'card:project')?.context.active_reconstruction).toBeNull();
    expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === 'processor:project')?.context.active_reconstruction).toBeNull();
    consoleError.mockRestore();
  }));

  it('creates a planner child and activates it in the same planning activation', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    let createdId = '';
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
        if (input.role === 'reviewer') return reviewerResult();
        const lastToolResult = (input.episodeContext.lastToolResult as { result?: { data?: { card?: { id: string }; outcome?: string } } } | undefined)?.result?.data;
        if (!lastToolResult) {
          return { kind: 'tool_calls' as const, tool_calls: [{ id: 'create-1', type: 'function' as const, function: { name: 'create_card', arguments: JSON.stringify({ type: 'code', title: 'Implement slice', brief: 'Build the slice\n\nAcceptance: Slice works' }) } }] };
        }
        if (lastToolResult.card) {
          createdId = lastToolResult.card.id;
          return { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: createdId }) } }] };
        }
        if (lastToolResult.outcome === 'done') return plannerResult('done', 'project done');
        throw new Error(`Unexpected last tool result ${JSON.stringify(lastToolResult)}`);
    });
    const children = {
      get: jest.fn((id: string) => {
        const card = store.read(id);
        return card ? makeChildActor(projectRoot, store, card, terminalProcessor({ status: 'done', summary: 'child done', result: { kind: 'done', summary: 'child done' } })) : null;
      }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    const created = store.read(createdId);
    expect(created).toMatchObject({ type: 'code', parent: project.id, status: 'done', title: 'Implement slice', created_by: 'planner' });
    expect(children.get).toHaveBeenCalledWith(createdId);
    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok', result: { kind: 'done', summary: 'review ok' } });
    expect(provider.completeTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({
      tools: expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: 'create_card' }) }),
        expect.objectContaining({ function: expect.objectContaining({ name: 'activate_card' }) }),
        expect.objectContaining({ function: expect.objectContaining({ name: 'reorder_child' }) }),
        expect.objectContaining({ function: expect.objectContaining({ name: 'queue_notification' }) }),
        expect.objectContaining({ function: expect.objectContaining({ name: 'list_cards' }) }),
        expect.objectContaining({ function: expect.objectContaining({ name: 'get_card' }) }),
        expect.objectContaining({ function: expect.objectContaining({ name: 'get_tree' }) }),
      ]),
    }), expect.any(AbortSignal));
  }));

  it('returns planner create_card project attempts as recoverable tool errors', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'project create rejected')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'create-project-1', type: 'function' as const, function: { name: 'create_card', arguments: JSON.stringify({ type: 'project', title: 'bad', brief: 'bad' }) } }] });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'project create rejected' });
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: { success: false, error: 'create_card cannot create project cards.' } }) }),
    }), expect.any(AbortSignal));
  }));

  it('edits a failed immediate child to changed so the planner can activate it again', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const failedGoal = markFailed(store, createGoal(store));
    const childActor = makeChildActor(projectRoot, store, failedGoal, terminalProcessor({ status: 'done', summary: 'child recovered', result: { kind: 'done', summary: 'child recovered' } }));
    let edited = false;
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
        if (input.role === 'reviewer') return reviewerResult();
        const lastToolResult = (input.episodeContext.lastToolResult as { result?: { data?: { card?: { id: string; status: string }; outcome?: string } } } | undefined)?.result?.data;
        if (!lastToolResult) return { kind: 'tool_calls' as const, tool_calls: [{ id: 'edit-1', type: 'function' as const, function: { name: 'edit_card', arguments: JSON.stringify({ card_id: failedGoal.id, title: 'Recovered child', priority: 2 }) } }] };
        if (lastToolResult.card) {
          edited = true;
          expect(lastToolResult.card).toMatchObject({ id: failedGoal.id, status: 'changed', title: 'Recovered child' });
          return { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: failedGoal.id }) } }] };
        }
        if (lastToolResult.outcome === 'done') return plannerResult('done', 'project done');
        throw new Error(`Unexpected last tool result ${JSON.stringify(lastToolResult)}`);
    });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: (id) => id === failedGoal.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(edited).toBe(true);
    expect(store.read(failedGoal.id)).toMatchObject({ status: 'done', title: 'Recovered child', priority: 2 });
    expect(outcome).toMatchObject({ status: 'done' });
  }));

  it('rejects planner edit_card for running and non-immediate children', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const runningGoal = store.setStatus(createGoal(store).id, 'running');
    const nestedParent = createGoal(store);
    const nestedChild = createGoal(store, nestedParent.id);
    const calls = [
      { id: 'edit-running', args: { card_id: runningGoal.id, title: 'Nope' } },
      { id: 'edit-nested', args: { card_id: nestedChild.id, title: 'Nope' } },
    ];
    let index = 0;
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
        if (input.episodeContext.lastToolResult) {
          index++;
          if (index >= calls.length) return plannerResult('blocked', 'edits rejected');
        }
        const call = calls[index];
        return { kind: 'tool_calls' as const, tool_calls: [{ id: call.id, type: 'function' as const, function: { name: 'edit_card', arguments: JSON.stringify(call.args) } }] };
    });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'edits rejected' });
    expect(store.read(runningGoal.id)).toMatchObject({ status: 'running', title: 'goal' });
    expect(store.read(nestedChild.id)).toMatchObject({ status: 'backlog', title: 'goal' });
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({ episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: expect.objectContaining({ success: false, error: expect.stringContaining('cannot edit running child') }) }) }) }), expect.any(AbortSignal));
    expect(provider.completeTurn).toHaveBeenNthCalledWith(3, expect.objectContaining({ episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: expect.objectContaining({ success: false, error: expect.stringContaining('can target only immediate children') }) }) }) }), expect.any(AbortSignal));
  }));

  it('cancels a parked immediate child through the child actor', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markBlocked(store, createGoal(store));
    const childActor = makeChildActor(projectRoot, store, child, terminalProcessor({ status: 'done', summary: 'unused', result: { kind: 'done', summary: 'unused' } }));
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'cancelled obsolete child')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'cancel-1', type: 'function' as const, function: { name: 'cancel_card', arguments: JSON.stringify({ card_id: child.id, reason: 'obsolete' }) } }] });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: (id) => id === child.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(store.read(child.id)?.status).toBe('cancelled');
    expect(outcome).toMatchObject({ status: 'blocked', summary: 'cancelled obsolete child' });
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({ episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: expect.objectContaining({ success: true, data: expect.objectContaining({ card_id: child.id, status: 'cancelled' }) }) }) }) }), expect.any(AbortSignal));
  }));

  it('authoritatively cancels a running immediate child', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = createGoal(store);
    let finish!: () => void;
    const childActor = makeChildActor(projectRoot, store, child, { activate: jest.fn(async () => new Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>((resolve) => { finish = () => resolve({ status: 'blocked', summary: 'still blocked', result: { kind: 'blocked', summary: 'still blocked', resume_reason: 'test' } }); })), disposeActivation: jest.fn(), joinActivation: jest.fn(async () => []), pendingJoinTaskCount: jest.fn(() => 0) });
    const childActivation = childActor.activate({ kind: 'parent', cardId: project.id });
    await eventually(() => expect(store.read(child.id)?.status).toBe('running'));
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'running cancel requested')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'cancel-1', type: 'function' as const, function: { name: 'cancel_card', arguments: JSON.stringify({ card_id: child.id }) } }] });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: (id) => id === child.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(store.read(child.id)?.status).toBe('cancelled');
    expect(childActor.listPendingNotifications()).toEqual([]);
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({ episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: expect.objectContaining({ success: true, data: expect.objectContaining({ card_id: child.id, status: 'cancelled' }) }) }) }) }), expect.any(AbortSignal));
    expect(outcome).toMatchObject({ status: 'blocked', summary: 'running cancel requested' });
    await expect(childActivation).resolves.toMatchObject({ status: 'cancelled' });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.read(child.id)?.status).toBe('cancelled');
  }));

  it('returns unsupported planner tools as recoverable tool errors', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'unsupported rejected')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'unsupported-1', type: 'function' as const, function: { name: 'restart_card', arguments: JSON.stringify({ card_id: project.id }) } }] });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'unsupported rejected' });
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: { success: false, error: "Unsupported planner tool call 'restart_card'." } }) }),
    }), expect.any(AbortSignal));
  }));

  it('returns malformed activate_card arguments as a recoverable tool result', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'tool args rejected')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: '' }) } }] });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'tool args rejected', result: { kind: 'blocked' } });
    expect(provider.completeTurn).toHaveBeenCalledTimes(3);
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: { success: false, error: 'activate_card requires card_id.' } }) }),
    }), expect.any(AbortSignal));
  }));

  it('returns failed child activation as a recoverable tool result', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const failedGoal = markFailed(store, createGoal(store));
    const childActor = makeChildActor(projectRoot, store, failedGoal, terminalProcessor({ status: 'done', summary: 'not invoked', result: { kind: 'done', summary: 'not invoked' } }));
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'child activation failed')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: failedGoal.id }) } }] });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: (id) => id === failedGoal.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'child activation failed', result: { kind: 'blocked' } });
    expect(store.read(failedGoal.id)?.status).toBe('failed');
    expect(provider.completeTurn).toHaveBeenCalledTimes(3);
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      episodeContext: expect.objectContaining({
        lastToolResult: expect.objectContaining({
          result: { success: false, error: `Card '${failedGoal.id}' in status 'failed' is not activatable.` },
        }),
      }),
    }), expect.any(AbortSignal));
  }));

  it('rejects old activate_card cardId alias instead of normalizing it', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'alias rejected')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ cardId: 'old-alias' }) } }] });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'alias rejected' });
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: expect.objectContaining({ success: false, error: expect.stringContaining('card_id') }) }) }),
    }), expect.any(AbortSignal));
  }));

  it('delivers card notifications to planner continuation turns by input id', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const goal = createGoal(store);
    const childActor = makeChildActor(projectRoot, store, goal, terminalProcessor({ status: 'done', summary: 'child done', result: { kind: 'done', summary: 'child done' } }));
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer'
        ? reviewerResult()
        : input.episodeContext.lastToolResult
        ? plannerResult('done', 'project done')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: goal.id }) } }] });
    const delivery = { deliverNotificationsForInput: jest.fn((inputId: string) => inputId.endsWith(':tool:1') ? [{ id: 'n-mid', message: 'mid-turn notice', created_at: '2026-06-12T00:00:00.000Z' }] : []) };
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: (id) => id === goal.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery }, new AbortController().signal);

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
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer' ? reviewerResult() : plannerResult('done', 'done'));
    const delivery = { deliverNotificationsForInput: jest.fn(() => []) };
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done' });
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith('planner:project:1');
    const reviewerInput = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls.find(([input]) => input.role === 'reviewer')?.[0];
    expect(reviewerInput).toMatchObject({ role: 'reviewer', systemPrompt: expect.stringContaining('project') });
    expect(reviewerInput?.contextMessages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', content: expect.stringContaining('Descendant work:') })]));
  }));

  it('does not drain main-agent notifications into reviewer tool continuations', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    let pendingNotifications = true;
    const delivery = {
      deliverNotificationsForInput: jest.fn((inputId: string) => {
        if (!inputId.startsWith('planner:') || !pendingNotifications) return [];
        pendingNotifications = false;
        return [{ id: 'n-reviewer-mid', message: 'must stay queued for planner', created_at: '2026-06-12T00:00:00.000Z' }];
      }),
    };
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
      if (input.role === 'reviewer') {
        if (input.episodeContext.lastToolResult) return reviewerResult();
        return { kind: 'tool_calls' as const, tool_calls: [{ id: 'reviewer-read-1', type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ path: 'missing-review-input.md' }) } }] };
      }
      return plannerResult('done', 'done');
    });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done' });
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith('planner:project:1');
    expect(delivery.deliverNotificationsForInput).not.toHaveBeenCalledWith(expect.stringMatching(/^reviewer:/));
    const reviewerContinuation = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls.find(([input]) => input.role === 'reviewer' && input.inputId.endsWith(':tool:1'))?.[0];
    expect(reviewerContinuation?.contextMessages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'must stay queued for planner' }),
    ]));
    expect(child.status).toBe('done');
  }));

  it('does not relaunch reviewer when main-agent notifications arrive during review', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    const delivery = { deliverNotificationsForInput: jest.fn(() => []) };
    let reviewerAttempts = 0;
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
        if (input.role === 'reviewer') {
          reviewerAttempts++;
          return reviewerResult();
        }
        return plannerResult('done', 'done');
    });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', result: { kind: 'done' } });
    expect(reviewerAttempts).toBe(1);
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith('planner:project:1');
  }));

  it('returns blocked reviewer correction when planner-owned review asks for corrections', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    let plannerAttempts = 0;
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
      if (input.role === 'reviewer') return reviewerResult({ status: 'rework', summary: 'fix it' });
      plannerAttempts++;
      return plannerResultWithCallId('done', 'done', `planner-done-${plannerAttempts}`);
    });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'fix it', result: { kind: 'rework', summary: 'fix it' } });
  }));

  it('feeds reviewer rework back to the planner with the concrete review record URL and separate notification context', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    markDone(store, createGoal(store, project.id));
    let reviewerAttempts = 0;
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
      if (input.role === 'reviewer') {
        reviewerAttempts++;
        return reviewerAttempts === 1
          ? reviewerResult({ status: 'rework', summary: 'missing proof' })
          : reviewerResult({ status: 'done', summary: 'review ok after rework' });
      }
      const lastToolResult = input.episodeContext.lastToolResult as { result?: { error?: string } } | undefined;
      if (typeof lastToolResult?.result?.error === 'string' && lastToolResult.result.error.includes('Reviewer requested rework')) {
        return plannerResult('done', 'fixed review issues');
      }
      return plannerResult('done', 'initial done');
    });
    const delivery = { deliverNotificationsForInput: jest.fn((inputId: string) => inputId.startsWith('planner:') && inputId.endsWith(':tool:2') ? [{ id: 'n-rework', message: 'review rework notice', created_at: '2026-06-12T00:00:00.000Z' }] : []) };
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok after rework', result: { kind: 'done', summary: 'review ok after rework' } });
    expect(reviewerAttempts).toBe(2);
    const plannerInputs = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls.map(([input]) => input).filter((input) => input.role === 'planner');
    const reworkInput = plannerInputs.find((input) => JSON.stringify(input.episodeContext.lastToolResult ?? {}).includes('Reviewer requested rework'));
    const reworkError = terminalToolResultError(reworkInput!, 'planner-done');
    expect(reworkError).toContain('record:///review.md?card=project&v=1');
    expect(reworkError).toContain('missing proof');
    expectNotificationSeparatedFromTerminalError(reworkError, 'review rework notice');
    expect(reworkInput?.contextMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'review rework notice' }),
    ]));
    expect(reworkInput?.contextMessages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Reviewer requested rework') }),
    ]));
  }));

  it('invokes reviewer for goal done outcomes', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const goal = createGoal(store);
    const child = markDone(store, createGoal(store, goal.id));
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer' ? reviewerResult() : plannerResult('done', 'goal done'));
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: goal.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: goal, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', result: { kind: 'done', summary: 'review ok' } });
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ agentId: `reviewer:${goal.id}`, role: 'reviewer', sessionId: `reviewer:${goal.id}:assessment-${goal.id}-1` }), expect.any(AbortSignal));
  }));

  it('blocks planner done when planner-owned reviewer requests rework', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    markDone(store, createGoal(store, project.id));
    let plannerAttempts = 0;
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
      if (input.role === 'reviewer') return reviewerResult({ status: 'rework', summary: 'missing proof' });
      plannerAttempts++;
      return plannerResultWithCallId('done', 'done', `planner-done-${plannerAttempts}`);
    });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'blocked', result: { kind: 'rework' } });
    expect(outcome.summary).toContain('missing proof');
  }));

  it('blocks planner done when reviewer terminal status is rework', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    markDone(store, createGoal(store, project.id));
    let plannerAttempts = 0;
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
      if (input.role === 'reviewer') return reviewerResult({ status: 'rework', summary: 'outside the reviewed subtree' });
      plannerAttempts++;
      return plannerResultWithCallId('done', 'done', `planner-done-${plannerAttempts}`);
    });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'blocked', result: { kind: 'rework' } });
    expect(outcome.summary).toContain('outside the reviewed subtree');
  }));

  it('repairs done reports while descendants remain incomplete with separate notification context', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const goal = createGoal(store);
    let sawCompletionGateFailure = false;
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
      if (input.role === 'reviewer') return reviewerResult();
      const lastToolResult = input.episodeContext.lastToolResult as { result?: { success?: boolean; error?: string } } | undefined;
      const error = lastToolResult?.result?.error;
      if (typeof error === 'string' && error.includes(`descendant '${goal.id}'`)) {
        sawCompletionGateFailure = true;
        markDone(store, goal);
      }
      return plannerResult('done', 'project done');
    });
    const delivery = { deliverNotificationsForInput: jest.fn((inputId: string) => inputId.endsWith(':tool:2') ? [{ id: 'n-gate', message: 'completion gate notice', created_at: '2026-06-12T00:00:00.000Z' }] : []) };
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', result: { kind: 'done' } });
    expect(sawCompletionGateFailure).toBe(true);
    expect(provider.completeTurn).toHaveBeenCalledTimes(6);
    const repairInput = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls.map(([input]) => input).find((input) => JSON.stringify(input.episodeContext.lastToolResult ?? {}).includes(`descendant '${goal.id}'`));
    const error = terminalToolResultError(repairInput!, 'planner-done');
    expect(error).toContain(`descendant '${goal.id}'`);
    expectNotificationSeparatedFromTerminalError(error, 'completion gate notice');
    expect(repairInput?.contextMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'completion gate notice' }),
    ]));
    expect(repairInput?.contextMessages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining(`descendant '${goal.id}'`) }),
    ]));
  }));

  it('does not invoke reviewer for blocked or failed planner outcomes', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider = withMandatoryRecords(() => plannerResult('blocked', 'blocked'));
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const blocked = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);
    provider.completeTurn = withMandatoryRecords(() => plannerResult('failed', 'failed')).completeTurn;
    const failed = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(blocked).toMatchObject({ status: 'blocked', result: { kind: 'blocked' } });
    expect(failed).toMatchObject({ status: 'failed', result: { kind: 'failed' } });
    expect(provider.completeTurn).toHaveBeenCalledTimes(2);
  }));

  it('continues planner tool calls past the previous 20-turn budget', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    let plannerTurns = 0;
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
        if (input.role === 'reviewer') return reviewerResult();
        plannerTurns++;
        if (plannerTurns <= 25) return { kind: 'tool_calls' as const, tool_calls: [{ id: `activate-${plannerTurns}`, type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: '' }) } }] };
        return plannerResult('blocked', 'blocked after extended planning');
    });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'blocked after extended planning', result: { kind: 'blocked' } });
    expect(plannerTurns).toBe(26);
    expect(provider.completeTurn).toHaveBeenCalledTimes(27);
  }));

  it('does not accept plain reviewer message JSON as terminal assessment', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    markDone(store, createGoal(store, project.id));
    let reviewerTurns = 0;
    const plainReviewerMessage = JSON.stringify({ status: 'done', summary: 'ok' });
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
      if (input.role !== 'reviewer') return plannerResult('done', 'done');
      reviewerTurns++;
      if (reviewerTurns <= 2) return { kind: 'message' as const, content: plainReviewerMessage };
      throw providerTurnFailure('model stopped after repeated plain reviewer messages');
    });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'failed', result: { kind: 'failed' } });
    expect(outcome.summary).toContain('model stopped after repeated plain reviewer messages');
    expect(outcome.summary).not.toBe('ok');
    const repairInput = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls.find((call) => call[0].role === 'reviewer' && call[0].contextMessages.some((message) => (message as { content?: string }).content === plainReviewerMessage))?.[0];
    expect(repairInput?.contextMessages).toEqual(expect.arrayContaining([
      { role: 'assistant', content: plainReviewerMessage },
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Plain reviewer messages are not accepted') }),
    ]));
  }));

  it('repairs plain reviewer prose and accepts a later terminal assessment', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    let reviewerTurns = 0;
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
      if (input.role !== 'reviewer') return plannerResult('done', 'done');
      reviewerTurns++;
      if (reviewerTurns === 1) return { kind: 'message' as const, content: 'Review passes.' };
      return reviewerResult();
    });
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', result: { kind: 'done' } });
    const repairInput = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls.find((call) => call[0].role === 'reviewer' && call[0].contextMessages.some((message) => (message as { content?: string }).content === 'Review passes.'))?.[0];
    expect(repairInput?.contextMessages).toEqual(expect.arrayContaining([
      { role: 'assistant', content: 'Review passes.' },
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Plain reviewer messages are not accepted') }),
    ]));
  }));

  it('repairs missing reviewer review record before projecting the assessment', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    markDone(store, createGoal(store, project.id));
    const actions: string[] = [];
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        const last = input.episodeContext.lastToolResult as { toolName?: string } | undefined;
        if (input.role === 'planner') {
          if (!last) {
            actions.push('planner_write_status');
            return providerCompletion(recordWrite('planner-status-before-review', 'record:///status.md?v=next', 'Planner status before review.'));
          }
          actions.push('planner_emit_done');
          return providerCompletion(plannerResult('done', 'ready for review'));
        }
        if (!last) {
          actions.push('reviewer_emit_without_review');
          return providerCompletion(reviewerResult({ status: 'done', summary: 'missing review first' }));
        }
        if (last.toolName === 'emit_result') {
          actions.push('reviewer_write_review_after_repair');
          return providerCompletion(recordWrite('reviewer-review-after-repair', 'record:///review.md?v=next', 'Reviewer assessment after repair.'));
        }
        actions.push('reviewer_emit_after_review');
        return providerCompletion(reviewerResult({ status: 'done', summary: 'review ok after missing-record repair' }));
      }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok after missing-record repair' });
    expect(actions).toEqual(['planner_write_status', 'planner_emit_done', 'reviewer_emit_without_review', 'reviewer_write_review_after_repair', 'reviewer_emit_after_review']);
    const calls = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls;
    const reviewerCalls = calls.filter(([input]) => input.role === 'reviewer');
    expect(reviewerCalls).toHaveLength(3);
    expect(reviewerCalls.map(([input]) => input.sessionId)).toEqual([
      `reviewer:${project.id}:assessment-${project.id}-1`,
      `reviewer:${project.id}:assessment-${project.id}-1`,
      `reviewer:${project.id}:assessment-${project.id}-1`,
    ]);
    const repairInput = reviewerCalls[1][0];
    const missingRecord = `Required record 'record:///review.md?card=${project.id}&v=next' was not created.`;
    const repairError = `${missingRecord} Create record:///review.md?v=next, then call emit_result again.`;
    expect(repairInput.episodeContext.lastToolResult).toMatchObject({
      toolCallId: 'reviewer-result-1',
      toolName: 'emit_result',
      result: { success: false, error: repairError },
    });
    expect(repairInput.contextMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', kind: 'tool_call', tool: 'emit_result', tool_call_id: 'reviewer-result-1' }),
      expect.objectContaining({ role: 'tool', kind: 'tool_result', tool: 'emit_result', tool_call_id: 'reviewer-result-1', content: JSON.stringify({ success: false, error: repairError }) }),
    ]));
    expect(repairInput.contextMessages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Create record:///review.md?v=next, then call emit_result again.') }),
    ]));
  }));

  it('does not accept plain planner message JSON as terminal result', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    let plannerTurns = 0;
    const plainPlannerMessage = JSON.stringify({ status: 'done', summary: 'done' });
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async () => {
        plannerTurns++;
        if (plannerTurns <= 2) return providerCompletion({ kind: 'message' as const, content: plainPlannerMessage });
        throw providerTurnFailure('model stopped after repeated plain planner messages');
      }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'failed', result: { kind: 'failed' } });
    expect(outcome.summary).toContain('model stopped after repeated plain planner messages');
    expect(outcome.summary).not.toBe('done');
    const repairInput = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls[1]?.[0];
    expect(repairInput.contextMessages).toEqual(expect.arrayContaining([
      { role: 'assistant', content: plainPlannerMessage },
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Plain planner messages are not accepted') }),
    ]));
  }));

  it('repairs plain planner prose with separate notification context and succeeds with a later terminal result', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    let plannerTurns = 0;
    const provider = withMandatoryRecords(() => {
      plannerTurns++;
      if (plannerTurns === 1) return { kind: 'message' as const, content: 'Project is done.' };
      return plannerResult('done', 'done after repair');
    });
    const delivery = { deliverNotificationsForInput: jest.fn((inputId: string) => inputId.endsWith(':tool:1') ? [{ id: 'n-plain', message: 'planner plain-text repair notice', created_at: '2026-06-12T00:00:00.000Z' }] : []) };
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'done after repair' });
    const repairInput = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls[1]?.[0];
    expect(repairInput.contextMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Plain planner messages are not accepted') }),
      expect.objectContaining({ role: 'user', content: 'planner plain-text repair notice' }),
    ]));
    expect(JSON.stringify(repairInput.episodeContext.lastToolResult ?? {})).not.toContain('planner plain-text repair notice');
  }));

  it('repairs invalid planner terminal arguments with separate notification context before projecting the outcome', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    let emittedInvalid = false;
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
      if (!emittedInvalid) {
        emittedInvalid = true;
        return { kind: 'tool_calls' as const, tool_calls: [{ id: 'bad-planner', type: 'function' as const, function: { name: 'emit_result', arguments: '{not json' } }] };
      }
      expect(input.episodeContext.lastToolResult).toMatchObject({ result: { success: false, error: expect.any(String) } });
      return plannerResult('blocked', 'valid after repair');
    });
    const delivery = { deliverNotificationsForInput: jest.fn((inputId: string) => inputId.endsWith(':tool:2') ? [{ id: 'n-invalid', message: 'planner invalid terminal notice', created_at: '2026-06-12T00:00:00.000Z' }] : []) };
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'valid after repair' });
    const repairInput = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls[2]?.[0];
    const error = terminalToolResultError(repairInput, 'bad-planner');
    expect(error).toContain("Terminal tool 'emit_result' arguments must be a JSON object.");
    expect(error).toContain('Call emit_result again with valid JSON arguments.');
    expectNotificationSeparatedFromTerminalError(error, 'planner invalid terminal notice');
    expect(repairInput.contextMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', kind: 'tool_result', tool: 'emit_result', tool_call_id: 'bad-planner', content: JSON.stringify({ success: false, error }) }),
      expect.objectContaining({ role: 'user', content: 'planner invalid terminal notice' }),
    ]));
    expect(repairInput.contextMessages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Call emit_result again with valid JSON arguments.') }),
    ]));
  }));

  it('repairs missing planner status record with separate notification context before projecting the terminal outcome', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const actions: string[] = [];
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        const last = input.episodeContext.lastToolResult as { toolName?: string } | undefined;
        if (!last) {
          actions.push('emit_without_status');
          return providerCompletion(plannerResult('blocked', 'missing record first'));
        }
        if (last.toolName === 'emit_result') {
          actions.push('write_status_after_repair');
          return providerCompletion(recordWrite('planner-status-after-repair', 'record:///status.md?v=next', 'Planner status after repair.'));
        }
        actions.push('emit_after_status');
        return providerCompletion(plannerResult('blocked', 'blocked after missing-record repair'));
      }),
    };
    const delivery = { deliverNotificationsForInput: jest.fn((inputId: string) => inputId.endsWith(':tool:1') ? [{ id: 'n-missing-status', message: 'planner missing status notice', created_at: '2026-06-12T00:00:00.000Z' }] : []) };
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'blocked after missing-record repair' });
    expect(actions).toEqual(['emit_without_status', 'write_status_after_repair', 'emit_after_status']);
    const calls = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.map(([input]) => input.sessionId)).toEqual([`planner:${project.id}`, `planner:${project.id}`, `planner:${project.id}`]);
    const repairInput = calls[1][0];
    const missingRecord = `Required record 'record:///status.md?card=${project.id}&v=next' was not created.`;
    const repairError = `${missingRecord} Create record:///status.md?v=next, then call emit_result again.`;
    expect(repairInput.episodeContext.lastToolResult).toMatchObject({
      toolCallId: 'planner-blocked',
      toolName: 'emit_result',
      result: { success: false, error: repairError },
    });
    const error = terminalToolResultError(repairInput, 'planner-blocked');
    expect(error).toBe(repairError);
    expectNotificationSeparatedFromTerminalError(error, 'planner missing status notice');
    expect(repairInput.contextMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', kind: 'tool_call', tool: 'emit_result', tool_call_id: 'planner-blocked' }),
      expect.objectContaining({ role: 'tool', kind: 'tool_result', tool: 'emit_result', tool_call_id: 'planner-blocked', content: JSON.stringify({ success: false, error: repairError }) }),
      expect.objectContaining({ role: 'user', content: 'planner missing status notice' }),
    ]));
    expect(repairInput.contextMessages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Create record:///status.md?v=next, then call emit_result again.') }),
    ]));
  }));

  it('throws a clear impossible-state error when active recovery lacks activation input', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const actor = new PlanningCardProcessorActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), cardId: project.id, store, children: { get: () => null }, provider: withMandatoryRecords(() => plannerResult('blocked', 'unused')) });

    expect(() => actor.recover('planning')).toThrow(/entered planning without activation input/);
  }));
});
