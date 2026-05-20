import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { parseActivationCompletionEnvelope } from '../../src/schemas/validators.js';
import { Runtime } from '../../src/utils/runtime.js';
import { CardStore } from '../../src/utils/card-store.js';
import { releaseLock } from '../../src/utils/runtime-lock.js';
import { saveRuntimeState, initRuntimeState, updateRuntimeState, readRuntimeState } from '../../src/utils/runtime-state.js';
import { appendMessage, createSession, getSessionMessages, listSessions } from '../../src/agents/session-persistence.js';
import { getUnhandledNotesQueue } from '../../src/utils/notes.js';
import { readProjectDirectives, recordLetsDanceDirective, recordProjectNeedsCorrectionsDirective } from '../../src/utils/analyst-stage6.js';
import type { ActiveCardRun, CardRecord, RuntimeState } from '../../src/schemas/types.js';
import type { AgentRuntime } from '../../src/agents/agent-runtime.js';
import type { PlannerResult, ExecutorResult, ReviewerResult } from '../../src/agents/result-parser.js';

function now(): string { return new Date().toISOString(); }
function runtimeState(run: ActiveCardRun | null): RuntimeState {
  return { status: run ? 'running' : 'idle', project_id: 'project', pid: process.pid, started_at: now(), current_card_id: run?.card_id ?? null, current_agent_session_id: run?.planner_session_id ?? run?.executor_session_id ?? run?.reviewer_session_id ?? null, active_card_run: run, paused: false, paused_at: null, queue: [], running_processes: [], updated_at: now(), frozen_reason: null };
}
function cardInput(id: string, type: CardRecord['type'], parent: string | null, status: CardRecord['status'] = 'backlog') {
  return { id, type, parent, depth: 0, title: id, description: id, status, depends_on: [], priority: 1, tags: [], urgency: 'normal' as const, created_by: 'planner' as const, blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 };
}
function addActivateCall(root: string, plannerCardId: string, childId: string, callId = `activate:${plannerCardId}:${childId}:0`) {
  const saivageDir = join(root, '.saivage');
  createSession(saivageDir, 'planner', plannerCardId, plannerCardId);
  appendMessage(saivageDir, `planner:${plannerCardId}`, { role: 'assistant', kind: 'tool_call', tool: 'activate_card', content: JSON.stringify({ toolCalls: [{ id: callId, type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ cardId: childId }) } }] }) });
  return callId;
}
function activationResults(root: string, plannerCardId: string) {
  return getSessionMessages(join(root, '.saivage'), `planner:${plannerCardId}`).filter((m) => m.kind === 'tool_result' && m.tool === 'activate_card');
}
function parseGoalContextBlock(content: string): Record<string, any> {
  const json = content.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`Goal Context JSON payload missing from: ${content}`);
  return JSON.parse(json);
}
class ScriptedAgent implements AgentRuntime {
  plannerCalls: string[] = [];
  reviewerCalls: string[] = [];
  reviewerOptions: Array<{ assessmentId?: string; reviewerSessionId?: string }> = [];
  prompts: string[] = [];
  constructor(private planner: Record<string, PlannerResult[]>, private reviewer: Record<string, ReviewerResult[]> = {}) {}
  invokePlanner(goalId: string, systemPrompt?: string): PlannerResult { this.plannerCalls.push(goalId); this.prompts.push(systemPrompt ?? ''); const next = this.planner[goalId]?.shift(); if (!next) return { status: 'blocked', blocked_reason: 'no scripted planner result', created_cards: [], updated_cards: [] };  return next; }
  invokeExecutor(_cardId: string, _goalId: string): ExecutorResult { throw new Error('executor should not be invoked by restart repair tests'); }
  invokeReviewer(goalId: string, _systemPrompt?: string, _contextMessages?: unknown[], options: { assessmentId?: string; reviewerSessionId?: string } = {}): ReviewerResult { this.reviewerCalls.push(goalId); this.reviewerOptions.push(options); const next = this.reviewer[goalId]?.shift(); if (!next) throw new Error(`no reviewer result for ${goalId}`); return next; }
  cancelSession(): boolean { return false; }
  forceCancelSession(): boolean { return false; }
  getHandoffSummary() { return null; }
  getActiveSessionHandoffs() { return []; }
}

describe('stage 7 runtime restart and orphan activate_card repair', () => {
  let root: string;
  let runtime: Runtime | null = null;
  let store: CardStore;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'saivage-restart-')); initProjectTree(root); store = new CardStore(root); });
  afterEach(async () => { if (runtime) { try { await runtime.shutdown(); } catch {} runtime = null; } try { releaseLock(root); } catch {} rmSync(root, { recursive: true, force: true }); });

  it('repairs an active_card_run planner phase by re-entering only that leaf planner', async () => {
    store.create(cardInput('goal-a', 'goal', 'project', 'running'));
    store.create(cardInput('goal-b', 'goal', 'project', 'backlog'));
    saveRuntimeState(root, runtimeState({ card_id: 'goal-a', card_type: 'goal', runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:goal-a', correction_attempts: 0, started_at: now(), last_turn_at: now() }));
    const agent = new ScriptedAgent({ 'goal-a': [{ status: 'blocked', blocked_reason: 'pause after restart', created_cards: [], updated_cards: [] }] });
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, agent);
    await runtime.startup();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(agent.plannerCalls).toContain('goal-a');
    expect(agent.plannerCalls).not.toContain('goal-b');
  });

  it('repairs executor phase by synthesizing a service_restart failure and one parent tool_result', async () => {
    store.create(cardInput('goal-a', 'goal', 'project', 'running'));
    store.create(cardInput('code-a', 'code', 'goal-a', 'running'));
    addActivateCall(root, 'goal-a', 'code-a');
    saveRuntimeState(root, runtimeState({ card_id: 'code-a', card_type: 'code', runtime_status: 'running', phase: 'executor', caller_session_id: null, caller_tool_call_id: null, executor_session_id: 'executor-code-a', correction_attempts: 0, started_at: now(), last_turn_at: now() }));
    const agent = new ScriptedAgent({ 'goal-a': [{ status: 'blocked', blocked_reason: 'observed failed child', created_cards: [], updated_cards: [] }] });
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, agent);
    await runtime.startup();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const card = runtime.cardStore.read('code-a')!;
    expect(card.status).toBe('failed');
    expect(card.result?.failure_kind).toBe('service_restart');
    const results = activationResults(root, 'goal-a');
    expect(results).toHaveLength(1);
    expect(parseActivationCompletionEnvelope(results[0]!.content)).toEqual(expect.objectContaining({ kind: 'activate_card_completion', outcome: 'failed', failure_kind: 'service_restart', cardId: 'code-a', success: false }));
  });

  it('repairs orphan activate_card calls from a terminal child status without active_card_run', async () => {
    store.create(cardInput('goal-a', 'goal', 'project', 'running'));
    store.create({ ...cardInput('code-a', 'code', 'goal-a', 'done'), result: { evidence: true } });
    addActivateCall(root, 'goal-a', 'code-a');
    saveRuntimeState(root, runtimeState(null));
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, new ScriptedAgent({}));
    await runtime.startup();
    const results = activationResults(root, 'goal-a');
    expect(results).toHaveLength(1);
    expect(parseActivationCompletionEnvelope(results[0]!.content)).toEqual(expect.objectContaining({ kind: 'activate_card_completion', outcome: 'done', child_card_id: 'code-a', cardId: 'code-a', success: true }));
  });

  it('repairs active_card_run from terminal child status exactly once', async () => {
    store.create(cardInput('goal-a', 'goal', 'project', 'running'));
    store.create({ ...cardInput('code-a', 'code', 'goal-a', 'done'), result: { evidence: true } });
    addActivateCall(root, 'goal-a', 'code-a');
    saveRuntimeState(root, runtimeState({ card_id: 'code-a', card_type: 'code', runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:code-a', correction_attempts: 0, started_at: now(), last_turn_at: now() }));
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, new ScriptedAgent({ 'goal-a': [{ status: 'blocked', blocked_reason: 'done', created_cards: [], updated_cards: [] }] }));
    await runtime.startup();
    await runtime.shutdown(); runtime = null; try { releaseLock(root); } catch {}
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, new ScriptedAgent({}));
    await runtime.startup();
    expect(activationResults(root, 'goal-a')).toHaveLength(1);
  });

  it('preallocates stable reviewer session ids and persists them across pause/resume restart state', async () => {
    store.create(cardInput('goal-a', 'goal', 'project', 'running'));
    store.create({ ...cardInput('code-a', 'code', 'goal-a', 'done'), result: { evidence: true } });
    const agent = new ScriptedAgent(
      { 'goal-a': [{ status: 'done', created_cards: [], updated_cards: [], summary: 'ready for review' }] },
      { 'goal-a': [{ assessment: { result: 'pass', summary: 'stable review passed', achieved: ['code-a'], issues: [], evidence_card_ids: ['code-a'] } }] },
    );
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, agent);
    await runtime.dispatchGoal('goal-a');
    const review = runtime.cardStore.read('goal-a')!.result!.review as Record<string, unknown>;
    expect(agent.reviewerOptions[0]).toEqual({ assessmentId: 'assessment-goal-a-1', reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1' });
    expect(review.assessment_id).toBe('assessment-goal-a-1');
    expect(review.reviewer_session_id).toBe('reviewer:goal-a:assessment-goal-a-1');

    updateRuntimeState(root, { status: 'paused', paused: true, paused_at: now(), current_card_id: 'goal-a', current_agent_session_id: review.reviewer_session_id as string, active_card_run: { card_id: 'goal-a', card_type: 'goal', runtime_status: 'running', phase: 'reviewer', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:goal-a', reviewer_session_id: review.reviewer_session_id as string, correction_attempts: 0, started_at: now(), last_turn_at: now() } });
    const paused = readRuntimeState(root)!;
    expect(paused.active_card_run?.reviewer_session_id).toBe('reviewer:goal-a:assessment-goal-a-1');
    await runtime.shutdown(); runtime = null; try { releaseLock(root); } catch {}

    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, new ScriptedAgent({}));
    await runtime.startup();
    expect((runtime.cardStore.read('goal-a')!.result!.review as Record<string, unknown>).reviewer_session_id).toBe('reviewer:goal-a:assessment-goal-a-1');
    expect(readRuntimeState(root)!.active_card_run?.reviewer_session_id).toBeUndefined();
  });

  it('recovers reviewer interrupt with reviewer_interrupted resume note and fresh assessment id', async () => {
    store.create(cardInput('goal-a', 'goal', 'project', 'running'));
    store.create({ ...cardInput('code-a', 'code', 'goal-a', 'done'), result: { evidence: true } });
    addActivateCall(root, 'project', 'goal-a');
    saveRuntimeState(root, runtimeState({ card_id: 'goal-a', card_type: 'goal', runtime_status: 'running', phase: 'reviewer', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:goal-a', reviewer_session_id: 'reviewer:goal-a:old-assessment', correction_attempts: 0, started_at: now(), last_turn_at: now() }));
    const agent = new ScriptedAgent(
      { 'goal-a': [{ status: 'done', created_cards: [], updated_cards: [], summary: 'planner reissued report_goal_done after reviewer_interrupted' }], project: [{ status: 'blocked', blocked_reason: 'parent observed child done', created_cards: [], updated_cards: [] }] },
      { 'goal-a': [{ assessment: { result: 'pass', summary: 'fresh review passed', achieved: ['code-a'], issues: [], evidence_card_ids: ['code-a'] } }] },
    );
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, agent);
    await runtime.startup();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const goal = runtime.cardStore.read('goal-a')!;
    expect(goal.result?.review).toEqual(expect.objectContaining({ result: 'pass' }));
    expect(String((goal.result?.review as Record<string, unknown>).assessment_id)).toBe('assessment-goal-a-1');
    expect(String((goal.result?.review as Record<string, unknown>).reviewer_session_id)).toBe('reviewer:goal-a:assessment-goal-a-1');
    expect(agent.reviewerOptions[0]).toEqual({ assessmentId: 'assessment-goal-a-1', reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1' });
    expect(agent.plannerCalls).toEqual(['goal-a']);
    expect(agent.reviewerCalls).toEqual(['goal-a']);
    const plannerMessages = getSessionMessages(join(root, '.saivage'), 'planner:goal-a');
    const synthetic = plannerMessages.filter((m) => m.role === 'user' && m.content.includes('reviewer_interrupted'));
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]!.content).toContain('resume_reason: reviewer_interrupted');
    expect(synthetic[0]!.content).toContain('interrupted_reviewer_session_id=reviewer:goal-a:old-assessment');
    expect(getUnhandledNotesQueue(join(root, '.saivage')).filter((n) => n.card_id === 'goal-a')).toHaveLength(0);
    const reviewerSessions = listSessions(join(root, '.saivage')).filter((id) => id.includes('old-assessment'));
    expect(reviewerSessions).toHaveLength(0);
    const parentResults = activationResults(root, 'project');
    expect(parentResults).toHaveLength(1);
    expect(JSON.parse(parentResults[0]!.content)).toEqual(expect.objectContaining({ outcome: 'done', cardId: 'goal-a' }));
  });

  it('does not treat reviewer phase as interrupted when result.review is already persisted', async () => {
    store.create({ ...cardInput('goal-a', 'goal', 'project', 'done'), result: { review: { assessment_id: 'persisted', at: now(), reviewer_session_id: 'reviewer:persisted', goal_card_id: 'goal-a', result: 'pass', summary: 'already persisted', achieved: [], issues: [], evidence_card_ids: [] } } });
    addActivateCall(root, 'project', 'goal-a');
    saveRuntimeState(root, runtimeState({ card_id: 'goal-a', card_type: 'goal', runtime_status: 'running', phase: 'reviewer', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:goal-a', reviewer_session_id: 'reviewer:persisted', correction_attempts: 0, started_at: now(), last_turn_at: now() }));
    const agent = new ScriptedAgent({});
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, agent);
    await runtime.startup();
    expect(agent.plannerCalls).toHaveLength(0);
    expect(activationResults(root, 'project')).toHaveLength(1);
  });

  it('emits canonical §9 recursive Goal Context user turns on planner start and runtime resume', async () => {
    const reportAt = now();
    store.create({
      ...cardInput('goal-a', 'goal', 'project', 'running'),
      description: 'parent goal',
      acceptance: 'accept it',
      tags: ['stage4'],
      priority: 42,
      depends_on: ['bootstrap-card'],
      blocks: ['release-card'],
      status_text: 'Working goal',
      latest_self_report: { result: 'blocked', summary: 'needs input', status_text: 'Needs input', at: reportAt },
      result: { review: { assessment_id: 'review-prior', at: reportAt, reviewer_session_id: 'reviewer:prior', goal_card_id: 'goal-a', result: 'needs_corrections', summary: 'prior corrections', achieved: [], issues: [], evidence_card_ids: [] } },
    });
    store.create({ ...cardInput('goal-child', 'goal', 'goal-a', 'backlog'), depth: 1, title: 'Child goal', status_text: 'Child pending' });
    store.create({
      ...cardInput('code-grandchild', 'code', 'goal-child', 'done'),
      depth: 2,
      title: 'Grandchild leaf',
      status_text: 'Grandchild done',
      latest_self_report: { result: 'done', summary: 'leaf finished', status_text: 'Grandchild done', at: reportAt },
      result: { executor: { evidence: 'synthetic' }, latest_self_report: { result: 'done', summary: 'leaf finished', status_text: 'Grandchild done', at: reportAt } },
    });
    const agent = new ScriptedAgent({ 'goal-a': [{ status: 'blocked', blocked_reason: 'pause for operator', created_cards: [], updated_cards: [] }] });
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, agent);
    await runtime.dispatchGoal('goal-a');
    const plannerMessages = getSessionMessages(join(root, '.saivage'), 'planner:goal-a').filter((m) => m.role === 'user' && m.content.includes('## Goal Context'));
    expect(plannerMessages).toHaveLength(1);
    const context = parseGoalContextBlock(plannerMessages[0]!.content);
    expect(context).toEqual(expect.objectContaining({
      id: 'goal-a',
      type: 'goal',
      parent_card_id: 'project',
      depth: 1,
      title: 'goal-a',
      description: 'parent goal',
      acceptance: ['accept it'],
      tags: ['stage4'],
      priority: 42,
      depends_on: ['bootstrap-card'],
      blocks: [],
      child_card_tree: expect.any(Array),
      notes: expect.any(Array),
      latest_self_report: expect.objectContaining({ result: 'blocked', summary: 'needs input', status_text: 'Needs input', at: reportAt }),
      latest_review_result: expect.objectContaining({ assessment_id: 'review-prior', result: 'needs_corrections' }),
      correction_attempts: 0,
      max_review_retries: 0,
      resume_reason: 'initial',
      status_text: 'Working goal',
    }));
    expect(context.child_card_tree).toEqual([expect.objectContaining({
      id: 'goal-child',
      type: 'goal',
      title: 'Child goal',
      status: 'backlog',
      status_text: 'Child pending',
      child_card_tree: [expect.objectContaining({
        id: 'code-grandchild',
        type: 'code',
        title: 'Grandchild leaf',
        status: 'done',
        status_text: 'Grandchild done',
      })],
    })]);
    expect(plannerMessages[0]!.content.trim()).toMatch(/resume_reason: initial$/);

    runtime.pause();
    updateRuntimeState(root, { status: 'paused', active_card_run: { card_id: 'goal-a', card_type: 'goal', runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:goal-a', correction_attempts: 2, started_at: now(), last_turn_at: now() }, current_card_id: 'goal-a', current_agent_session_id: 'planner:goal-a' });
    runtime.resume();
    const resumedMessages = getSessionMessages(join(root, '.saivage'), 'planner:goal-a').filter((m) => m.role === 'user' && m.content.includes('## Goal Context'));
    expect(resumedMessages).toHaveLength(2);
    const resumedContext = parseGoalContextBlock(resumedMessages[1]!.content);
    expect(resumedContext).toEqual(expect.objectContaining({
      id: 'goal-a',
      resume_reason: 'initial',
      correction_attempts: 2,
      status_text: 'Working goal',
    }));
    expect(resumedContext.child_card_tree[0].child_card_tree[0]).toEqual(expect.objectContaining({ id: 'code-grandchild', status_text: 'Grandchild done' }));
    expect(resumedMessages[1]!.content.trim()).toMatch(/resume_reason: initial$/);
  });

  it.each([
    { kind: 'lets_dance' as const, record: () => recordLetsDanceDirective(root), key: 'lets_dance' as const },
    { kind: 'project_needs_corrections' as const, record: () => recordProjectNeedsCorrectionsDirective(root, [{ summary: 'correct project', severity: 'warning' }]), key: 'project_needs_corrections' as const },
  ])('buffers $kind while paused and consumes exactly once after resume safe tick', async ({ record, key }) => {
    record();
    const agent = new ScriptedAgent({ project: [{ status: 'blocked', blocked_reason: 'project started', created_cards: [], updated_cards: [] }] });
    initRuntimeState(root);
    updateRuntimeState(root, { status: 'paused', paused: true, paused_at: now() });
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, agent);
    await runtime.startup();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(agent.plannerCalls).toHaveLength(0);
    expect(readProjectDirectives(root)[key]).toBeTruthy();

    runtime.resume();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(agent.plannerCalls).toEqual(['project']);
    expect(readProjectDirectives(root)[key]).toBeUndefined();
    runtime.resume();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(agent.plannerCalls).toEqual(['project']);
  });

  it.each([
    { kind: 'lets_dance' as const, record: () => recordLetsDanceDirective(root), key: 'lets_dance' as const },
    { kind: 'project_needs_corrections' as const, record: () => recordProjectNeedsCorrectionsDirective(root, [{ summary: 'correct project', severity: 'warning' }]), key: 'project_needs_corrections' as const },
  ])('preserves $kind directives across restart and activates project exactly once through safe tick', async ({ record, key }) => {
    record();
    const firstAgent = new ScriptedAgent({});
    initRuntimeState(root);
    updateRuntimeState(root, { status: 'paused', paused: true, paused_at: now() });
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, firstAgent);
    await runtime.startup();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(firstAgent.plannerCalls).toHaveLength(0);
    expect(readProjectDirectives(root)[key]).toBeTruthy();
    await runtime.shutdown(); runtime = null; try { releaseLock(root); } catch {}

    const secondAgent = new ScriptedAgent({ project: [{ status: 'blocked', blocked_reason: 'directive started', created_cards: [], updated_cards: [] }] });
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, secondAgent);
    await runtime.startup();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(secondAgent.plannerCalls).toEqual(['project']);
    expect(readProjectDirectives(root)[key]).toBeUndefined();
    await runtime.shutdown(); runtime = null; try { releaseLock(root); } catch {}

    const thirdAgent = new ScriptedAgent({ project: [{ status: 'blocked', blocked_reason: 'would be duplicate', created_cards: [], updated_cards: [] }] });
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, thirdAgent);
    await runtime.startup();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(thirdAgent.plannerCalls).toHaveLength(0);
  });

  it('routes startup repair through safe tick without project directive consumption or direct dispatch before repair completes', async () => {
    store.create(cardInput('goal-a', 'goal', 'project', 'running'));
    store.create(cardInput('code-a', 'code', 'goal-a', 'running'));
    addActivateCall(root, 'goal-a', 'code-a');
    recordLetsDanceDirective(root);
    saveRuntimeState(root, runtimeState({ card_id: 'code-a', card_type: 'code', runtime_status: 'running', phase: 'executor', caller_session_id: null, caller_tool_call_id: null, executor_session_id: 'executor-code-a', correction_attempts: 0, started_at: now(), last_turn_at: now() }));
    const agent = new ScriptedAgent({ 'goal-a': [{ status: 'blocked', blocked_reason: 'observed failed child', created_cards: [], updated_cards: [] }], project: [{ status: 'blocked', blocked_reason: 'project directive later', created_cards: [], updated_cards: [] }] });
    const original = (Runtime.prototype as unknown as { dispatchGoal: Runtime['dispatchGoal'] }).dispatchGoal;
    let startupReturned = false;
    const callsDuringRepair: string[] = [];
    (runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: {}, fixtureDir: root } }, agent));
    const instance = runtime as unknown as { dispatchGoal: Runtime['dispatchGoal']; safeTick: () => Promise<void> };
    instance.dispatchGoal = (async (goalId: string) => { if (!startupReturned) callsDuringRepair.push(goalId); return original.call(runtime as Runtime, goalId); }) as Runtime['dispatchGoal'];
    await runtime.startup();
    startupReturned = true;
    expect(callsDuringRepair).toHaveLength(0);
    expect(readProjectDirectives(root).lets_dance).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(agent.plannerCalls).toEqual(['goal-a']);
    expect(readProjectDirectives(root).lets_dance).toBeTruthy();

    await instance.safeTick();
    expect(agent.plannerCalls).toEqual(['goal-a', 'project']);
    expect(readProjectDirectives(root).lets_dance).toBeUndefined();
  });

  it('keeps pending_subprocess acceptance gate behavior deferred while durable process tools exist', async () => {
    const module = await import('../../src/utils/process-runner.js');
    expect(module).toHaveProperty('waitProcess');
    expect(module).toHaveProperty('killProcess');
    expect(module).toHaveProperty('reconcileProcessRecords');
    const haystack = readFileSync(join(process.cwd(), 'src', 'utils', 'planner-tools.ts'), 'utf-8');
    expect(haystack).not.toMatch(/pending_subprocess/);
    expect(existsSync(join(root, '.saivage', 'runtime', 'process-records.json'))).toBe(false);
  });});
