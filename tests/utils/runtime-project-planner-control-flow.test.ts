import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { Runtime } from '../../src/utils/runtime.js';
import { FakeAgentAdapter, type FakeAgentFixture, type FakeReviewerResult } from '../../src/utils/fake-agent.js';
import { releaseLock } from '../../src/utils/runtime-lock.js';
import { getSessionMessages } from '../../src/agents/session-persistence.js';
import { AgentAdapter, createAgentAdapter } from '../../src/agents/agent-adapter.js';

function activateMessages(root: string, plannerCardId: string) {
  return getSessionMessages(join(root, '.saivage'), `planner:${plannerCardId}`).filter((m) => m.tool === 'activate_card');
}

describe('Runtime caller-edge reconstruction from unresolved activate_card calls', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let runtime: Runtime;

  function makeFixtureDir(baseDir: string): string { const dir = join(baseDir, 'fixtures'); mkdirSync(dir, { recursive: true }); return dir; }
  function writeFixture(dir: string, name: string, fixture: FakeAgentFixture): void { writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2), 'utf-8'); }

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'saivage-project-loop-')); fixtureDir = makeFixtureDir(tmpDir); initProjectTree(tmpDir); });
  afterEach(async () => { if (runtime) { try { await runtime.shutdown(); } catch {} } try { releaseLock(tmpDir); } catch {} rmSync(tmpDir, { recursive: true, force: true }); });

  it('resumes parent planners by appending exactly one tool_result to the real activate_card tool_call_id', async () => {
    const projectFixture: FakeAgentFixture = { name: 'project-parent', planner: [{ status: 'done', created_cards: [{ id: 'goal-parent-1', type: 'goal', title: 'Initial top-level goal', description: 'Create the first top-level goal.', status: 'backlog', depends_on: [], priority: 1 }], summary: 'Initial project planning created one top-level goal.' }, { status: 'done', created_cards: [{ id: 'goal-parent-2', type: 'goal', title: 'Second top-level goal', description: 'Create a second top-level goal after the first completes.', status: 'backlog', depends_on: [], priority: 2 }], summary: 'Project planner resumed and created a second top-level goal.' }, { status: 'done', created_cards: [], summary: 'Project planner resumed again after the second goal completed and confirmed no further work.' }], reviewer: [{ assessment: { id: 'review-project', goal_card_id: 'project', reviewer_session_id: 'rev-project', assessment_id: 'assessment-test', at: '2025-01-01T00:00:00.000Z', result: 'pass', summary: 'Project planning and follow-up goals were accepted.', achieved: ['Created first top-level goal', 'Created second top-level goal after resume'], issues: [], evidence_card_ids: ['goal-parent-1', 'goal-parent-2'], created_at: new Date().toISOString() } }] };
    const goalOneReview: FakeReviewerResult = { assessment: { id: 'review-goal-1', goal_card_id: 'goal-parent-1', reviewer_session_id: 'rev-goal-1', assessment_id: 'assessment-test', at: '2025-01-01T00:00:00.000Z', result: 'pass', summary: 'Both leaf cards executed.', achieved: ['Execution evidence for code-parent-1', 'Execution evidence for code-parent-2'], issues: [], evidence_card_ids: ['code-parent-1', 'code-parent-2'], created_at: new Date().toISOString() } };
    const goalTwoReview: FakeReviewerResult = { assessment: { id: 'review-goal-2', goal_card_id: 'goal-parent-2', reviewer_session_id: 'rev-goal-2', assessment_id: 'assessment-test', at: '2025-01-01T00:00:00.000Z', result: 'pass', summary: 'The second top-level goal leaf card executed.', achieved: ['Execution evidence for code-parent-3'], issues: [], evidence_card_ids: ['code-parent-3'], created_at: new Date().toISOString() } };
    const goalOneFixture: FakeAgentFixture = { name: 'goal-two-leaves', planner: [{ status: 'done', created_cards: [{ id: 'code-parent-1', type: 'code', title: 'First leaf card', description: 'This card should execute.', status: 'backlog', depends_on: [], priority: 1 }, { id: 'code-parent-2', type: 'code', title: 'Second leaf card', description: 'This card should execute after the first.', status: 'backlog', depends_on: ['code-parent-1'], priority: 2 }], summary: 'Created two child cards and declared done.' }, { status: 'done', created_cards: [], summary: 'Goal planner resumed after first child execution and is waiting for remaining evidence.' }, { status: 'done', created_cards: [], summary: 'Goal planner resumed after second child execution and is ready for final review.' }], executor: { 'code-parent-1': { card_id: 'code-parent-1', status: 'done', status_text: 'Completed successfully', result: { evidence: 'completed first leaf card' } }, 'code-parent-2': { card_id: 'code-parent-2', status: 'done', status_text: 'Completed successfully', result: { evidence: 'completed second leaf card' } } }, reviewer: [goalOneReview, goalOneReview, goalOneReview] };
    const goalTwoFixture: FakeAgentFixture = { name: 'goal-one-leaf', planner: [{ status: 'done', created_cards: [{ id: 'code-parent-3', type: 'code', title: 'Third leaf card', description: 'This card should execute for the second top-level goal.', status: 'backlog', depends_on: [], priority: 1 }], summary: 'Created one child card and declared done.' }, { status: 'done', created_cards: [], summary: 'Goal planner resumed after child execution and confirmed completion.' }], executor: { 'code-parent-3': { card_id: 'code-parent-3', status: 'done', status_text: 'Completed successfully', result: { evidence: 'completed third leaf card' } } }, reviewer: [goalTwoReview] };
    writeFixture(fixtureDir, 'project-parent', projectFixture); writeFixture(fixtureDir, 'goal-two-leaves', goalOneFixture); writeFixture(fixtureDir, 'goal-one-leaf', goalTwoFixture);
    const fakeAgent = new FakeAgentAdapter({ mapping: { project: 'project-parent', 'goal-parent-1': 'goal-two-leaves', 'goal-parent-2': 'goal-one-leaf' }, fixtureDir });
    runtime = new Runtime({ projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'project-parent', 'goal-parent-1': 'goal-two-leaves', 'goal-parent-2': 'goal-one-leaf' }, fixtureDir } }, fakeAgent);
    await runtime.startup(); await runtime.dispatchGoal('project');

    for (const id of ['goal-parent-1', 'goal-parent-2', 'code-parent-1', 'code-parent-2', 'code-parent-3']) expect(runtime.cardStore.read(id)?.status).toBe('done');
    expect(existsSync(join(tmpDir, '.saivage', 'runtime', 'planner-frames'))).toBe(false);
    expect(existsSync(join(tmpDir, '.saivage', 'runtime', 'planner-dispatches'))).toBe(false);

    const projectActivateMessages = activateMessages(tmpDir, 'project');
    const projectCalls = projectActivateMessages.filter((m) => m.kind === 'tool_call');
    const projectResults = projectActivateMessages.filter((m) => m.kind === 'tool_result');
    expect(projectCalls).toHaveLength(2);
    expect(projectResults).toHaveLength(2);
    expect(projectResults.map((m) => m.tool_call_id).sort()).toEqual(['activate:project:goal-parent-1:0', 'activate:project:goal-parent-2:1']);
    expect(projectResults.filter((m) => m.tool_call_id === 'activate:project:goal-parent-1:0')).toHaveLength(1);

    const goalOneResults = activateMessages(tmpDir, 'goal-parent-1').filter((m) => m.kind === 'tool_result');
    expect(goalOneResults.map((m) => m.tool_call_id).sort()).toEqual(['activate:goal-parent-1:code-parent-1:0', 'activate:goal-parent-1:code-parent-2:0']);
    expect(runtime.cardStore.read('project')?.result?.review).toEqual(expect.objectContaining({ result: 'pass', evidence_card_ids: ['goal-parent-1', 'goal-parent-2'] }));
  });

  it('covers two nested goal activation levels and project-root completion cleanup', async () => {
    const projectFixture: FakeAgentFixture = { name: 'project-stage4', planner: [{ status: 'done', created_cards: [{ id: 'goal-parent', type: 'goal', title: 'Parent goal', description: 'parent', status: 'backlog', depends_on: [], priority: 1 }], summary: 'created parent' }, { status: 'done', created_cards: [], summary: 'project complete' }], reviewer: [{ assessment: { id: 'review-project-stage4', goal_card_id: 'project', reviewer_session_id: 'rev-project-stage4', assessment_id: 'assessment-test', at: '2025-01-01T00:00:00.000Z', result: 'pass', summary: 'project done', achieved: ['parent goal done'], issues: [], evidence_card_ids: ['goal-parent'], created_at: new Date().toISOString() } }] };
    const parentGoalFixture: FakeAgentFixture = { name: 'goal-parent-stage4', planner: [{ status: 'done', created_cards: [{ id: 'goal-child', type: 'goal', title: 'Child goal', description: 'child', status: 'backlog', depends_on: [], priority: 1 }], summary: 'created child' }, { status: 'done', created_cards: [], summary: 'parent complete' }], reviewer: [{ assessment: { id: 'review-goal-parent-stage4', goal_card_id: 'goal-parent', reviewer_session_id: 'rev-parent-stage4', assessment_id: 'assessment-test', at: '2025-01-01T00:00:00.000Z', result: 'pass', summary: 'parent done', achieved: ['child goal done'], issues: [], evidence_card_ids: ['goal-child'], created_at: new Date().toISOString() } }] };
    const childGoalFixture: FakeAgentFixture = { name: 'goal-child-stage4', planner: [{ status: 'done', created_cards: [{ id: 'code-leaf', type: 'code', title: 'Leaf code', description: 'leaf', status: 'backlog', depends_on: [], priority: 1 }], summary: 'created leaf' }, { status: 'done', created_cards: [], summary: 'child complete' }], executor: { 'code-leaf': { card_id: 'code-leaf', status: 'done', status_text: 'leaf complete', result: { evidence: true } } }, reviewer: [{ assessment: { id: 'review-goal-child-stage4', goal_card_id: 'goal-child', reviewer_session_id: 'rev-child-stage4', assessment_id: 'assessment-test', at: '2025-01-01T00:00:00.000Z', result: 'pass', summary: 'child done', achieved: ['leaf complete'], issues: [], evidence_card_ids: ['code-leaf'], created_at: new Date().toISOString() } }] };
    writeFixture(fixtureDir, 'project-stage4', projectFixture); writeFixture(fixtureDir, 'goal-parent-stage4', parentGoalFixture); writeFixture(fixtureDir, 'goal-child-stage4', childGoalFixture);
    const fakeAgent = new FakeAgentAdapter({ mapping: { project: 'project-stage4', 'goal-parent': 'goal-parent-stage4', 'goal-child': 'goal-child-stage4' }, fixtureDir });
    runtime = new Runtime({ projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'project-stage4', 'goal-parent': 'goal-parent-stage4', 'goal-child': 'goal-child-stage4' }, fixtureDir } }, fakeAgent);
    const completionEvents: Array<Record<string, unknown>> = [];
    runtime.on('project_run_completed', (event) => completionEvents.push(event as Record<string, unknown>));
    await runtime.startup(); await runtime.dispatchGoal('project');

    expect(runtime.getState()?.active_card_run).toBeNull();
    expect(runtime.getState()?.current_card_id).toBeNull();
    expect(runtime.cardStore.read('goal-child')?.parent).toBe('goal-parent');
    expect(runtime.cardStore.read('code-leaf')?.parent).toBe('goal-child');
    expect(activateMessages(tmpDir, 'project').filter((m) => m.kind === 'tool_result').map((m) => m.tool_call_id)).toEqual(['activate:project:goal-parent:0']);
    expect(activateMessages(tmpDir, 'goal-parent').filter((m) => m.kind === 'tool_result').map((m) => m.tool_call_id)).toEqual(['activate:goal-parent:goal-child:0']);
    expect(activateMessages(tmpDir, 'goal-child').filter((m) => m.kind === 'tool_result').map((m) => m.tool_call_id)).toEqual(['activate:goal-child:code-leaf:0']);
    expect(completionEvents).toEqual([{ project_card_id: 'project', result: 'done', summary: 'project done' }]);
  });

  it('preserves public runtime and adapter APIs', () => {
    expect(typeof Runtime.prototype.emitAgentEvent).toBe('function');
    expect(typeof AgentAdapter.prototype.getSafeFileContent).toBe('function');
    expect(typeof createAgentAdapter).toBe('function');
  });
});
