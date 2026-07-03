import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { CardActor, PlanningCardProcessorActor, readActorSnapshots, type CardActivationInput, type CardActivationOutcome, type CardProcessorActor, type LLMProviderPort } from '../../../src/runtime/actors/index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import type { LlmCompleteResult } from '../../../src/agents/llm-contracts.js';
import type { CardRecord } from '../../../src/schemas/index.js';
import { closeOpenRecordSlot, openRecordSlot } from '../../../src/runtime/records/record-slots.js';

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

function writeBrief(projectRoot: string, cardId: string, content: string, cardVersionSeq = 1): void {
  const slot = openRecordSlot(projectRoot, { cardId, filename: 'brief.md' });
  writeFileSync(slot.absolutePath, content, 'utf-8');
  closeOpenRecordSlot(projectRoot, { cardId, filename: 'brief.md', writer: 'planner', cardVersionSeq });
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
  return { activate: jest.fn(async () => outcome) as (input: CardActivationInput) => Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>> };
}

function noopNotificationDelivery() {
  return { hasPendingNotifications: () => false, deliverNotificationsForInput: () => [] };
}

function plannerResult(status: 'done' | 'blocked' | 'failed', summary: string) {
  return {
    kind: 'tool_calls' as const,
    tool_calls: [{ id: `planner-${status}`, type: 'function' as const, function: { name: 'emit_result', arguments: JSON.stringify({ status, summary }) } }],
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

function invocationToolNames(input: LlmInvocationInput): string[] {
  return input.tools.map((tool) => tool.function.name).sort();
}

function capturedInput(provider: LLMProviderPort, role: 'planner' | 'reviewer'): LlmInvocationInput {
  const calls = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls;
  const input = calls.find(([candidate]) => candidate.role === role)?.[0];
  if (!input) throw new Error(`Missing ${role} invocation input`);
  return input;
}

function withMandatoryRecords(responder: (input: LlmInvocationInput) => Promise<LlmCompleteResult> | LlmCompleteResult): LLMProviderPort {
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
          return pendingTerminal;
        }
      }
      const result = await responder(input);
      if (result.kind !== 'tool_calls') return result;
      if (result.tool_calls.some((toolCall) => toolCall.function.name === 'emit_result') && input.role === 'planner') {
        pending.set(key, result);
        const count = (recordWrites.get(key) ?? 0) + 1;
        recordWrites.set(key, count);
        return recordWrite(`status-${key}-${count}`, 'record://status.md?v=next', `Status for ${input.episodeContext.cardId ?? key}`);
      }
      if (result.tool_calls.some((toolCall) => toolCall.function.name === 'emit_result') && input.role === 'reviewer') {
        pending.set(key, result);
        const count = (recordWrites.get(key) ?? 0) + 1;
        recordWrites.set(key, count);
        return recordWrite(`review-${key}-${count}`, 'record://review.md?v=next', `Review for ${input.episodeContext.cardId ?? key}`);
      }
      return result;
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
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const delivery = { deliverNotificationsForInput: jest.fn(() => [{ id: 'n1', message: 'Cancellation requested: stop', created_at: '2026-06-12T00:00:00.000Z' }]) };
    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery });

    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok', result: { kind: 'done', summary: 'review ok' } });
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      role: 'planner',
      contextMessages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Cancellation requested: stop' }),
      ]),
      terminalToolNames: ['emit_result'],
      systemPrompt: expect.stringContaining('record://status.md?v=next'),
      tools: expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'emit_result' }) })]),
    }), expect.any(AbortSignal));
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      agentId: `reviewer:${project.id}`,
      role: 'reviewer',
      sessionId: `reviewer:${project.id}:assessment-${project.id}-1`,
      terminalToolNames: ['emit_result'],
      systemPrompt: expect.stringContaining('record://review.md?v=next'),
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
  }));

  it('builds planner and reviewer prompts from the latest brief record', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    writeBrief(projectRoot, project.id, '# Goal\n\nPlan from brief record.\n\n# Acceptance Criteria\n\nReview from brief record.\n', project.version_seq);
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
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

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
    const childActor = CardActor.fromCard({ projectRoot, card: goal, store, processor: terminalProcessor({ status: 'done', summary: 'child done', result: { kind: 'done', summary: 'child done' } }) });
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer'
        ? reviewerResult()
        : input.episodeContext.lastToolResult
        ? plannerResult('done', 'project done')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: goal.id }) } }] });
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: (id) => id === goal.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'done', summary: 'review ok', result: { kind: 'done', summary: 'review ok' } });
    expect(store.read(goal.id)?.status).toBe('done');
    expect(provider.completeTurn).toHaveBeenCalledTimes(5);
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: expect.objectContaining({ data: expect.objectContaining({ outcome: 'done', card_id: goal.id }) }) }) }),
    }), expect.any(AbortSignal));
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
        return card ? CardActor.fromCard({ projectRoot, card, store, processor: terminalProcessor({ status: 'done', summary: 'child done', result: { kind: 'done', summary: 'child done' } }) }) : null;
      }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

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
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

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
    const childActor = CardActor.fromCard({ projectRoot, card: failedGoal, store, processor: terminalProcessor({ status: 'done', summary: 'child recovered', result: { kind: 'done', summary: 'child recovered' } }) });
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
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: (id) => id === failedGoal.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

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
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

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
    const childActor = CardActor.fromCard({ projectRoot, card: child, store, processor: terminalProcessor({ status: 'done', summary: 'unused', result: { kind: 'done', summary: 'unused' } }) });
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'cancelled obsolete child')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'cancel-1', type: 'function' as const, function: { name: 'cancel_card', arguments: JSON.stringify({ card_id: child.id, reason: 'obsolete' }) } }] });
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: (id) => id === child.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(store.read(child.id)?.status).toBe('cancelled');
    expect(outcome).toMatchObject({ status: 'blocked', summary: 'cancelled obsolete child' });
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({ episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: expect.objectContaining({ success: true, data: expect.objectContaining({ card_id: child.id, status: 'cancelled' }) }) }) }) }), expect.any(AbortSignal));
  }));

  it('requests cancellation for a running immediate child without synchronously stopping it', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = createGoal(store);
    let finish!: () => void;
    const childActor = CardActor.fromCard({ projectRoot, card: child, store, processor: { activate: jest.fn(async () => new Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>((resolve) => { finish = () => resolve({ status: 'blocked', summary: 'still blocked', result: { kind: 'blocked', summary: 'still blocked', resume_reason: 'test' } }); })) } });
    const childActivation = childActor.activate({ kind: 'parent', cardId: project.id });
    await eventually(() => expect(store.read(child.id)?.status).toBe('running'));
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'running cancel requested')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'cancel-1', type: 'function' as const, function: { name: 'cancel_card', arguments: JSON.stringify({ card_id: child.id }) } }] });
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: (id) => id === child.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(store.read(child.id)?.status).toBe('running');
    expect(childActor.listPendingNotifications()).toEqual([expect.objectContaining({ reason: 'cancel_requested' })]);
    expect(provider.completeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({ episodeContext: expect.objectContaining({ lastToolResult: expect.objectContaining({ result: expect.objectContaining({ success: true, data: expect.objectContaining({ card_id: child.id, status: 'running', summary: 'Cancellation requested.' }) }) }) }) }), expect.any(AbortSignal));
    expect(outcome).toMatchObject({ status: 'blocked', summary: 'running cancel requested' });
    finish();
    await expect(childActivation).resolves.toMatchObject({ status: 'blocked' });
  }));

  it('returns unsupported planner tools as recoverable tool errors', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'unsupported rejected')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'unsupported-1', type: 'function' as const, function: { name: 'restart_card', arguments: JSON.stringify({ card_id: project.id }) } }] });
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
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'tool args rejected')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: '' }) } }] });
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

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
    const childActor = CardActor.fromCard({ projectRoot, card: failedGoal, store, processor: terminalProcessor({ status: 'done', summary: 'not invoked', result: { kind: 'done', summary: 'not invoked' } }) });
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? plannerResult('blocked', 'child activation failed')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: failedGoal.id }) } }] });
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: (id) => id === failedGoal.id ? childActor : null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

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
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

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
    const childActor = CardActor.fromCard({ projectRoot, card: goal, store, processor: terminalProcessor({ status: 'done', summary: 'child done', result: { kind: 'done', summary: 'child done' } }) });
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer'
        ? reviewerResult()
        : input.episodeContext.lastToolResult
        ? plannerResult('done', 'project done')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: goal.id }) } }] });
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
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer' ? reviewerResult() : plannerResult('done', 'done'));
    const delivery = { hasPendingNotifications: jest.fn(() => false), deliverNotificationsForInput: jest.fn(() => []) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery });

    expect(outcome).toMatchObject({ status: 'done' });
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith('planner:project:1');
    const reviewerInput = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls.find(([input]) => input.role === 'reviewer')?.[0];
    expect(reviewerInput).toMatchObject({ role: 'reviewer', systemPrompt: expect.stringContaining('project') });
    expect(reviewerInput?.contextMessages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', content: expect.stringContaining('Descendant work:') })]));
  }));

  it('relaunches reviewer when main-agent notifications arrive during review', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    const delivery = { hasPendingNotifications: jest.fn(() => false), deliverNotificationsForInput: jest.fn(() => []) };
    let reviewerAttempts = 0;
    const provider = withMandatoryRecords((input: LlmInvocationInput) => {
        if (input.role === 'reviewer') {
          reviewerAttempts++;
          if (reviewerAttempts === 1) delivery.hasPendingNotifications.mockReturnValue(true);
          return reviewerResult();
        }
        return plannerResult('done', 'done');
    });
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: delivery });

    expect(outcome).toMatchObject({ status: 'done', result: { kind: 'done' } });
    expect(reviewerAttempts).toBe(2);
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith('planner:project:1');
  }));

  it('returns blocked reviewer correction when planner-owned review asks for corrections', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = markDone(store, createGoal(store, project.id));
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer' ? reviewerResult({ status: 'rework', summary: 'fix it' }) : plannerResult('done', 'done'));
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'fix it', result: { kind: 'rework', summary: 'fix it' } });
  }));

  it('invokes reviewer for goal done outcomes', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const goal = createGoal(store);
    const child = markDone(store, createGoal(store, goal.id));
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer' ? reviewerResult() : plannerResult('done', 'goal done'));
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: goal.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: goal, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'done', result: { kind: 'done', summary: 'review ok' } });
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ agentId: `reviewer:${goal.id}`, role: 'reviewer', sessionId: `reviewer:${goal.id}:assessment-${goal.id}-1` }), expect.any(AbortSignal));
  }));

  it('blocks planner done when planner-owned reviewer requests rework', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    markDone(store, createGoal(store, project.id));
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer' ? reviewerResult({ status: 'rework', summary: 'missing proof' }) : plannerResult('done', 'done'));
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', result: { kind: 'rework' } });
    expect(outcome.summary).toContain('missing proof');
  }));

  it('blocks planner done when reviewer terminal status is rework', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    markDone(store, createGoal(store, project.id));
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer' ? reviewerResult({ status: 'rework', summary: 'outside the reviewed subtree' }) : plannerResult('done', 'done'));
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', result: { kind: 'rework' } });
    expect(outcome.summary).toContain('outside the reviewed subtree');
  }));

  it('blocks done reports while descendants remain incomplete', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const goal = createGoal(store);
    const provider = withMandatoryRecords(() => plannerResult('done', 'project done'));
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', result: { kind: 'blocked' } });
    expect(outcome.summary).toContain(goal.id);
    expect(provider.completeTurn).toHaveBeenCalledTimes(2);
  }));

  it('does not invoke reviewer for blocked or failed planner outcomes', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider = withMandatoryRecords(() => plannerResult('blocked', 'blocked'));
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const blocked = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });
    provider.completeTurn = withMandatoryRecords(() => plannerResult('failed', 'failed')).completeTurn;
    const failed = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

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
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'blocked after extended planning', result: { kind: 'blocked' } });
    expect(plannerTurns).toBe(26);
    expect(provider.completeTurn).toHaveBeenCalledTimes(27);
  }));

  it('does not accept plain reviewer message JSON as terminal assessment', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    markDone(store, createGoal(store, project.id));
    const provider = withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer' ? { kind: 'message' as const, content: JSON.stringify({ status: 'done', summary: 'ok' }) } : plannerResult('done', 'done'));
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'failed', result: { kind: 'failed' } });
    expect(outcome.summary).toContain('emit_result');
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
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

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
            return recordWrite('planner-status-before-review', 'record://status.md?v=next', 'Planner status before review.');
          }
          actions.push('planner_emit_done');
          return plannerResult('done', 'ready for review');
        }
        if (!last) {
          actions.push('reviewer_emit_without_review');
          return reviewerResult({ status: 'done', summary: 'missing review first' });
        }
        if (last.toolName === 'emit_result') {
          actions.push('reviewer_write_review_after_repair');
          return recordWrite('reviewer-review-after-repair', 'record://review.md?v=next', 'Reviewer assessment after repair.');
        }
        actions.push('reviewer_emit_after_review');
        return reviewerResult({ status: 'done', summary: 'review ok after missing-record repair' });
      }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

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
    const missingRecord = `Required record 'record://review.md?card=${project.id}&v=next' was not created.`;
    expect(repairInput.episodeContext.lastToolResult).toMatchObject({
      toolCallId: 'reviewer-result-1',
      toolName: 'emit_result',
      result: { success: false, error: missingRecord },
    });
    expect(repairInput.contextMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', kind: 'tool_call', tool: 'emit_result', tool_call_id: 'reviewer-result-1' }),
      expect.objectContaining({ role: 'tool', kind: 'tool_result', tool: 'emit_result', tool_call_id: 'reviewer-result-1', content: JSON.stringify({ success: false, error: missingRecord }) }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Create record://review.md?v=next, then call emit_result again.') }),
    ]));
  }));

  it('does not accept plain planner message JSON as terminal result', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: JSON.stringify({ status: 'done', summary: 'done' }) })) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'failed', result: { kind: 'failed' } });
    expect(outcome.summary).toContain('emit_result');
  }));

  it('repairs plain planner prose and succeeds with a later terminal result', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    let plannerTurns = 0;
    const provider = withMandatoryRecords(() => {
      plannerTurns++;
      if (plannerTurns === 1) return { kind: 'message' as const, content: 'Project is done.' };
      return plannerResult('done', 'done after repair');
    });
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'done', summary: 'done after repair' });
  }));

  it('repairs invalid planner terminal arguments before projecting the outcome', async () => withTempProject(async (projectRoot) => {
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
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'valid after repair' });
  }));

  it('repairs missing planner status record before projecting the terminal outcome', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const actions: string[] = [];
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        const last = input.episodeContext.lastToolResult as { toolName?: string } | undefined;
        if (!last) {
          actions.push('emit_without_status');
          return plannerResult('blocked', 'missing record first');
        }
        if (last.toolName === 'emit_result') {
          actions.push('write_status_after_repair');
          return recordWrite('planner-status-after-repair', 'record://status.md?v=next', 'Planner status after repair.');
        }
        actions.push('emit_after_status');
        return plannerResult('blocked', 'blocked after missing-record repair');
      }),
    };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider });
    actor.start();

    const outcome = await actor.activate({ card: project, caller: { kind: 'root' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'blocked after missing-record repair' });
    expect(actions).toEqual(['emit_without_status', 'write_status_after_repair', 'emit_after_status']);
    const calls = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.map(([input]) => input.sessionId)).toEqual([`planner:${project.id}`, `planner:${project.id}`, `planner:${project.id}`]);
    const repairInput = calls[1][0];
    const missingRecord = `Required record 'record://status.md?card=${project.id}&v=next' was not created.`;
    expect(repairInput.episodeContext.lastToolResult).toMatchObject({
      toolCallId: 'planner-blocked',
      toolName: 'emit_result',
      result: { success: false, error: missingRecord },
    });
    expect(repairInput.contextMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', kind: 'tool_call', tool: 'emit_result', tool_call_id: 'planner-blocked' }),
      expect.objectContaining({ role: 'tool', kind: 'tool_result', tool: 'emit_result', tool_call_id: 'planner-blocked', content: JSON.stringify({ success: false, error: missingRecord }) }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Create record://status.md?v=next, then call emit_result again.') }),
    ]));
  }));

  it('throws a clear impossible-state error when recovering directly into planning', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: project.id, store, children: { get: () => null }, provider: withMandatoryRecords(() => plannerResult('blocked', 'unused')) });

    expect(() => actor.recover('planning')).toThrow(/cannot recover directly into active state 'planning'/);
  }));
});
