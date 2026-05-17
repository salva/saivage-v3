import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { Runtime } from '../../src/utils/runtime.js';
import { CardStore } from '../../src/utils/card-store.js';
import { releaseLock } from '../../src/utils/runtime-lock.js';
import { saveRuntimeState } from '../../src/utils/runtime-state.js';
import { appendMessage, createSession, getSessionMessages, listSessions } from '../../src/agents/session-persistence.js';
import { getUnhandledNotesQueue } from '../../src/utils/notes.js';
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
class ScriptedAgent implements AgentRuntime {
  plannerCalls: string[] = [];
  reviewerCalls: string[] = [];
  prompts: string[] = [];
  constructor(private planner: Record<string, PlannerResult[]>, private reviewer: Record<string, ReviewerResult[]> = {}) {}
  invokePlanner(goalId: string, systemPrompt?: string): PlannerResult { this.plannerCalls.push(goalId); this.prompts.push(systemPrompt ?? ''); const next = this.planner[goalId]?.shift(); if (!next) return { status: 'blocked', blocked_reason: 'no scripted planner result', created_cards: [], updated_cards: [] };  return next; }
  invokeExecutor(_cardId: string, _goalId: string): ExecutorResult { throw new Error('executor should not be invoked by restart repair tests'); }
  invokeReviewer(goalId: string): ReviewerResult { this.reviewerCalls.push(goalId); const next = this.reviewer[goalId]?.shift(); if (!next) throw new Error(`no reviewer result for ${goalId}`); return next; }
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
    expect(JSON.parse(results[0]!.content)).toEqual(expect.objectContaining({ outcome: 'failed', failure_kind: 'service_restart' }));
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
    expect(JSON.parse(results[0]!.content)).toEqual(expect.objectContaining({ outcome: 'done', cardId: 'code-a' }));
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
    expect(String((goal.result?.review as Record<string, unknown>).assessment_id)).not.toBe('old-assessment');
    expect(agent.plannerCalls).toEqual(['goal-a']);
    expect(agent.reviewerCalls).toEqual(['goal-a']);
    const plannerMessages = getSessionMessages(join(root, '.saivage'), 'planner:goal-a');
    const synthetic = plannerMessages.filter((m) => m.role === 'user' && m.content.includes('reviewer_interrupted'));
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]!.content).toContain('resume_reason: reviewer_interrupted');
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

  it('keeps deferred durable async process features absent', () => {
    const roots = ['src', 'tests'];
    const files: string[] = [];
    const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, entry.name); if (entry.isDirectory()) walk(p); else if (/\.(ts|js)$/.test(entry.name)) files.push(p); } };
    roots.forEach((r) => walk(join(process.cwd(), r)));
    const haystack = files.filter((f) => f.includes(`${join('src', '')}`)).map((f) => `${f}\n${readFileSync(f, 'utf-8')}`).join('\n');
    const deferredPatterns = [
      /wait_for_process/,
      /kill_process/,
      /pending_subprocess/,
      /identity_probe/,
      /restartIdentityProbe/i,
      /reattach_process/,
      /pause_time_process_buffer/,
    ];
    for (const pattern of deferredPatterns) expect(haystack).not.toMatch(pattern);
    expect(existsSync(join(root, '.saivage', 'runtime', 'process-records.json'))).toBe(false);
  });
});
