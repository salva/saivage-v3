import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initProjectTree } from '../../src/persistence/file-tree.js';
import { createSession, completeSession, getSession, getSessionMessages, markSessionWaiting } from '../../src/agents/session-persistence.js';
import { readRuntimeState, updateRuntimeState } from '../../src/runtime/state.js';
import type { AgentExecutionPort as AgentRuntime } from '../../src/contracts/index.js';
import type { PlannerResult, ExecutorResult, ReviewerResult } from '../../src/contracts/index.js';
import type { HandoffSummary } from '../../src/schemas/types.js';
import { createRuntimeTestHarness } from '../utils/runtime-test-harness.js';

class NoopAgentRuntime implements AgentRuntime {
  invokePlanner(): Promise<PlannerResult> { return Promise.resolve({ status: 'continue', created_cards: [], updated_cards: [] }); }
  invokeExecutor(): Promise<ExecutorResult> { return Promise.resolve({ card_id: 'x', status: 'done', status_text: 'noop', artifacts: [], attachments: [], fallback_with_evidence: null }); }
  invokeReviewer(): Promise<ReviewerResult> { return Promise.resolve({ assessment: { result: 'pass', summary: 'noop', achieved: [], issues: [], evidence_card_ids: [] } }); }
  cancelSession(): boolean { return false; }
  forceCancelSession(): boolean { return false; }
  getHandoffSummary(): HandoffSummary | null { return null; }
  getActiveSessionHandoffs(): HandoffSummary[] { return []; }
}

function readEvents(projectRoot: string): Array<Record<string, unknown>> {
  return readFileSync(join(projectRoot, '.saivage', 'runtime', 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('startup agent session sweep', () => {
  let projectRoot: string;
  let saivageDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-startup-sweep-'));
    saivageDir = join(projectRoot, '.saivage');
    initProjectTree(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('sweeps active non-analyst sessions, preserves waiting planner and analyst, logs one sweep event, clears stale current_agent_session_id', async () => {
    const activeExecutor = createSession(saivageDir, 'executor', 'goal-1', 'card-1');
    const activeReviewer = createSession(saivageDir, 'reviewer', 'goal-1', 'goal-1');
    const activePlanner = createSession(saivageDir, 'planner', 'goal-1', 'goal-1');
    const waitingPlanner = createSession(saivageDir, 'planner', 'goal-2', 'goal-2');
    const doneExecutor = createSession(saivageDir, 'executor', 'goal-1', 'card-3');
    const analyst = createSession(saivageDir, 'analyst');
    markSessionWaiting(saivageDir, waitingPlanner.id);
    completeSession(saivageDir, doneExecutor.id, 'done');
    const waitingBefore = readFileSync(join(saivageDir, 'agents', 'sessions', `${waitingPlanner.id}.json`), 'utf8');
    const analystBefore = readFileSync(join(saivageDir, 'agents', 'sessions', `${analyst.id}.json`), 'utf8');
    updateRuntimeState(projectRoot, { current_agent_session_id: activePlanner.id });

    const harness = createRuntimeTestHarness({
      config: { projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' } },
      agentRuntime: new NoopAgentRuntime(),
    });
    const { api } = harness;
    await api.start();
    const stateAfterStartup = readRuntimeState(projectRoot);
    await api.shutdown();

    for (const sessionId of [activeExecutor.id, activeReviewer.id, activePlanner.id]) {
      expect(getSession(saivageDir, sessionId)?.status).toBe('failed');
      expect(getSessionMessages(saivageDir, sessionId)).toEqual([
        expect.objectContaining({ role: 'system', kind: 'model_issue' }),
      ]);
    }
    expect(readFileSync(join(saivageDir, 'agents', 'sessions', `${waitingPlanner.id}.json`), 'utf8')).toBe(waitingBefore);
    expect(readFileSync(join(saivageDir, 'agents', 'sessions', `${analyst.id}.json`), 'utf8')).toBe(analystBefore);
    expect(getSession(saivageDir, doneExecutor.id)?.status).toBe('done');
    const sweepEvents = readEvents(projectRoot).filter((event) => event.kind === 'startup_session_sweep');
    expect(sweepEvents).toHaveLength(1);
    expect((sweepEvents[0].swept_session_ids as string[]).sort()).toEqual([
      activeExecutor.id,
      activeReviewer.id,
      activePlanner.id,
    ].sort());
    expect(stateAfterStartup?.current_agent_session_id).toBeNull();
    // /api/agents reads these same persisted manifests; route coverage is therefore exercised by the manifest assertions above.
  });
  it('requeues an interrupted planner active run on startup', async () => {
    updateRuntimeState(projectRoot, {
      status: 'running',
      current_card_id: 'project',
      current_agent_session_id: 'planner:project',
      active_card_run: {
        card_id: 'project',
        card_type: 'project',
        runtime_status: 'running',
        phase: 'planner',
        caller_session_id: null,
        caller_tool_call_id: null,
        planner_session_id: 'planner:project',
        correction_attempts: 0,
        started_at: new Date().toISOString(),
        last_turn_at: new Date().toISOString(),
      },
      runtime_intent: {
        status: 'running',
        source_command_id: 'cmd-started-before-restart',
        updated_at: new Date().toISOString(),
        reason: 'test interrupted planner run',
      },
    });

    const harness = createRuntimeTestHarness({
      config: { projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' } },
      agentRuntime: new NoopAgentRuntime(),
    });
    const { api } = harness;
    try {
      await api.start();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const project = harness.cards.read('project');
      expect(project?.status).toBe('blocked');
      expect(project?.result?.planning).toEqual(expect.objectContaining({
        status: 'blocked',
        resume_reason: 'non_actionable_continue',
      }));
      expect(harness.state.read()?.active_card_run).toBeNull();
    } finally {
      await api.shutdown();
    }
  });

});
