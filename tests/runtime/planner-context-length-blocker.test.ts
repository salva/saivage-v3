import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { updateRuntimeState } from '../../src/runtime/state.js';
import {
  appendMessage,
  getSessionMessages,
  createSession,
} from '../../src/agents/session-persistence.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { FakeAgentAdapter } from '../../src/agents/fake-agent.js';
import { LlmRequestError } from '../../src/agents/llm-errors.js';
import { releaseLock } from '../../src/runtime/lock.js';
import type {
  PlannerInvocationRequest,
  PlannerResult,
  ReviewerResult,
} from '../../src/contracts/index.js';

class ContextLengthPlannerAdapter extends FakeAgentAdapter {
  invokePlanner(_request: PlannerInvocationRequest): PlannerResult;
  invokePlanner(_goalId: string, _systemPrompt?: string): PlannerResult;
  invokePlanner(): PlannerResult {
    throw new LlmRequestError({
      kind: 'token_budget_exceeded',
      provider: 'test-provider',
      status: 400,
      message: 'LLM token budget exceeded (HTTP 400): context_length_exceeded',
    });
  }
}

class TerminalToolExhaustionPlannerAdapter extends FakeAgentAdapter {
  invokePlanner(_request: PlannerInvocationRequest): PlannerResult;
  invokePlanner(_goalId: string, _systemPrompt?: string): PlannerResult;
  invokePlanner(): PlannerResult {
    throw new Error("Role 'planner' did not emit terminal tool within 16 turns.");
  }
}

class ContinuePlannerCapturingAdapter extends FakeAgentAdapter {
  capturedPrompt = '';

  invokePlanner(request: PlannerInvocationRequest): PlannerResult;
  invokePlanner(goalId: string, systemPrompt?: string): PlannerResult;
  invokePlanner(
    requestOrGoalId: PlannerInvocationRequest | string,
    systemPrompt?: string,
  ): PlannerResult {
    this.capturedPrompt =
      typeof requestOrGoalId === 'string'
        ? (systemPrompt ?? '')
        : (requestOrGoalId.systemPrompt ?? '');
    return {
      status: 'continue',
      created_cards: [
        {
          id: 'next-safe-work',
          type: 'code',
          title: 'Next safe work',
          description: 'A scheduler-critical child created after compacting planner history.',
          status: 'backlog',
          priority: 0,
          depends_on: [],
        },
      ],
      updated_cards: [],
      summary: 'planner retry proceeded after compaction',
    };
  }
}

class DonePlannerWithPassingReviewerAdapter extends FakeAgentAdapter {
  invokePlanner(_request: PlannerInvocationRequest): PlannerResult;
  invokePlanner(_goalId: string, _systemPrompt?: string): PlannerResult;
  invokePlanner(): PlannerResult {
    return {
      status: 'done',
      created_cards: [],
      updated_cards: [],
      summary: 'Planner incorrectly tried to finish despite a persisted planning blocker.',
    };
  }

  invokeReviewer(): ReviewerResult {
    return {
      assessment: {
        result: 'pass',
        summary: 'Reviewer pass must not clear a precise planning blocker.',
        achieved: [],
        issues: [],
        evidence_card_ids: ['project'],
      },
    };
  }
}

describe('planner context-length failures', () => {
  let tmpDir: string;
  let runtime: Runtime;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-planner-context-length-'));
    mkdirSync(join(tmpDir, 'fixtures'), { recursive: true });
    initProjectTree(tmpDir);
  });

  afterEach(async () => {
    if (runtime) {
      try {
        await runtime.shutdown();
      } catch {
        /* noop */
      }
    }
    try {
      releaseLock(tmpDir);
    } catch {
      /* noop */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists a durable blocker instead of throwing when planner invocation exceeds token budget', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContextLengthPlannerAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    runtime = new Runtime(
      { projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'unused' }, fixtureDir } },
      fakeAgent,
    );

    await runtime.startup();
    await expect(runtime.dispatchGoal('project')).resolves.toBeUndefined();

    const project = runtime.cardStore.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.error).toContain('Planner context exceeded');
    expect(project?.result?.planning).toEqual(
      expect.objectContaining({
        status: 'blocked',
        resume_reason: 'planner_context_length_exceeded',
        failure_kind: 'token_budget_exceeded',
        created_cards: [],
        updated_cards: [],
      }),
    );
    expect(runtime.getState()?.active_card_run).toBeNull();
    expect(runtime.getState()?.current_card_id).toBeNull();
  });

  it('persists planner terminal-tool exhaustion as a durable blocker instead of failing the project', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new TerminalToolExhaustionPlannerAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    runtime = new Runtime(
      { projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'unused' }, fixtureDir } },
      fakeAgent,
    );

    await runtime.startup();
    await expect(runtime.dispatchGoal('project')).resolves.toBeUndefined();

    const project = runtime.cardStore.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.error).toContain('Planner did not emit a terminal scheduler tool');
    expect(project?.result?.planning).toEqual(
      expect.objectContaining({
        status: 'blocked',
        resume_reason: 'planner_terminal_tool_exhausted',
        failure_kind: 'planner_contract_terminal_tool_exhausted',
        created_cards: [],
        updated_cards: [],
      }),
    );
    expect(runtime.getState()?.status).toBe('idle');
    expect(runtime.getState()?.active_card_run).toBeNull();
    expect(runtime.getState()?.current_card_id).toBeNull();
  });

  it('aligns a persisted failed project from planner terminal-tool exhaustion to a precise blocker on startup', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new TerminalToolExhaustionPlannerAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    runtime = new Runtime(
      { projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'unused' }, fixtureDir } },
      fakeAgent,
    );
    runtime.cardStore.update('project', {
      status: 'failed',
      error: "Role 'planner' did not emit terminal tool within 16 turns.",
      status_text: "Planner failed: Role 'planner' did not emit terminal tool within 16 turns.",
      result: {
        planning: {
          status: 'continue',
          resume_reason: 'review_completed',
          created_cards: [],
          updated_cards: [],
        },
      },
    });
    updateRuntimeState(tmpDir, {
      status: 'idle',
      current_card_id: null,
      current_agent_session_id: null,
      active_card_run: null,
    });

    await runtime.startup();

    const project = runtime.cardStore.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.error).toContain('Planner did not emit a terminal scheduler tool');
    expect(project?.result?.planning).toEqual(
      expect.objectContaining({
        status: 'blocked',
        resume_reason: 'planner_terminal_tool_exhausted',
        failure_kind: 'planner_contract_terminal_tool_exhausted',
      }),
    );
    expect(runtime.getState()?.status).toBe('idle');
    expect(runtime.getState()?.current_card_id).toBeNull();
    expect(runtime.getState()?.active_card_run).toBeNull();
    expect(runtime.getBackgroundDispatchCount()).toBe(0);
  });

  it('aligns active/running card status with persisted context-length planning blockers on startup', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContextLengthPlannerAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    runtime = new Runtime(
      { projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'unused' }, fixtureDir } },
      fakeAgent,
    );
    const blockedReason =
      'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    runtime.cardStore.update('project', {
      status: 'running',
      result: {
        planning: {
          status: 'blocked',
          resume_reason: 'planner_context_length_exceeded',
          failure_kind: 'token_budget_exceeded',
          blocked_reason: blockedReason,
        },
      },
    });
    updateRuntimeState(tmpDir, {
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
    });

    await runtime.startup();

    const project = runtime.cardStore.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.status_text).toBe(blockedReason);
    expect(project?.result?.planning).toEqual(
      expect.objectContaining({
        status: 'blocked',
        resume_reason: 'planner_context_length_exceeded',
        failure_kind: 'token_budget_exceeded',
      }),
    );
    expect(runtime.getState()?.status).toBe('idle');
    expect(runtime.getState()?.current_card_id).toBeNull();
    expect(runtime.getState()?.active_card_run).toBeNull();
  });

  it('does not redispatch a persisted blocked planning card on startup', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContextLengthPlannerAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    runtime = new Runtime(
      { projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'unused' }, fixtureDir } },
      fakeAgent,
    );
    const blockedReason =
      'planner remains durably blocked until an explicit operator or state change';
    runtime.cardStore.update('project', {
      status: 'blocked',
      error: blockedReason,
      status_text: blockedReason,
      result: {
        planning: {
          status: 'blocked',
          resume_reason: 'planner_context_length_exceeded',
          failure_kind: 'token_budget_exceeded',
          blocked_reason: blockedReason,
        },
      },
    });
    updateRuntimeState(tmpDir, {
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
    });

    await runtime.startup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (
      runtime as unknown as { _stateMachine: { requestImmediateTick(): Promise<void> } }
    )._stateMachine.requestImmediateTick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const project = runtime.cardStore.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.error).toBe(blockedReason);
    expect(project?.result?.planning).toEqual(
      expect.objectContaining({
        status: 'blocked',
        resume_reason: 'planner_context_length_exceeded',
        failure_kind: 'token_budget_exceeded',
      }),
    );
    expect(runtime.getState()?.status).toBe('idle');
    expect(runtime.getState()?.current_card_id).toBeNull();
    expect(runtime.getState()?.active_card_run).toBeNull();
    expect(runtime.getBackgroundDispatchCount()).toBe(0);
  });

  it('aligns done project status with persisted precise planning blockers on startup', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContextLengthPlannerAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    runtime = new Runtime(
      { projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'unused' }, fixtureDir } },
      fakeAgent,
    );
    const blockedReason =
      'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    runtime.cardStore.update('project', {
      status: 'done',
      error: blockedReason,
      status_text: blockedReason,
      result: {
        planning: {
          status: 'blocked',
          resume_reason: 'planner_context_length_exceeded',
          failure_kind: 'token_budget_exceeded',
          blocked_reason: blockedReason,
        },
      },
    });

    await runtime.startup();

    const project = runtime.cardStore.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.error).toBe(blockedReason);
    expect(project?.status_text).toBe(blockedReason);
    expect(project?.result?.planning).toEqual(
      expect.objectContaining({
        status: 'blocked',
        resume_reason: 'planner_context_length_exceeded',
        failure_kind: 'token_budget_exceeded',
      }),
    );
    expect(runtime.getState()?.status).toBe('idle');
    expect(runtime.getState()?.current_card_id).toBeNull();
    expect(runtime.getState()?.active_card_run).toBeNull();
  });

  it('does not restart running intent when the project has a durable planning blocker', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContextLengthPlannerAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    runtime = new Runtime(
      { projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'unused' }, fixtureDir } },
      fakeAgent,
    );
    const blockedReason =
      'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    runtime.cardStore.update('project', {
      status: 'done',
      error: blockedReason,
      status_text: blockedReason,
      result: {
        planning: {
          status: 'blocked',
          resume_reason: 'planner_context_length_exceeded',
          failure_kind: 'token_budget_exceeded',
          blocked_reason: blockedReason,
        },
      },
    });
    updateRuntimeState(tmpDir, {
      status: 'idle',
      current_card_id: null,
      current_agent_session_id: null,
      active_card_run: null,
      runtime_intent: {
        status: 'running',
        updated_at: new Date().toISOString(),
        source_command_id: 'cmd-old',
        reason: 'continuous runtime intent should not bypass durable blocker',
      },
      runtime_runs: [],
    });

    await runtime.startup();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const project = runtime.cardStore.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.result?.planning).toEqual(
      expect.objectContaining({
        status: 'blocked',
        resume_reason: 'planner_context_length_exceeded',
      }),
    );
    expect(runtime.getState()?.status).toBe('idle');
    expect(runtime.getState()?.current_card_id).toBeNull();
    expect(runtime.getState()?.active_card_run).toBeNull();
    expect(runtime.getState()?.runtime_runs ?? []).toHaveLength(0);
    expect(runtime.getBackgroundDispatchCount()).toBe(0);
  });

  it('compacts oversized persisted planner history and clears stale token-budget blocker before retry', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContinuePlannerCapturingAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    runtime = new Runtime(
      { projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'unused' }, fixtureDir } },
      fakeAgent,
    );
    const saivageDir = join(tmpDir, '.saivage');
    createSession(saivageDir, 'planner', 'project', 'project', undefined, 'planner:project');
    for (let index = 0; index < 40; index += 1) {
      appendMessage(
        saivageDir,
        'planner:project',
        {
          role: index % 2 === 0 ? 'user' : 'assistant',
          kind: index % 5 === 0 ? 'tool_result' : 'text',
          tool: index % 5 === 0 ? 'read_project_file' : undefined,
          content: `old persisted planner transcript ${index} ${'oversized-history-body '.repeat(3000)}`,
        },
        {
          round_id: `r-user-${String(index).padStart(32, '0')}`,
          message_index: index,
          block_index: index,
        },
      );
    }
    const blockedReason =
      'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    runtime.cardStore.update('project', {
      status: 'blocked',
      error: blockedReason,
      status_text: blockedReason,
      result: {
        planning: {
          status: 'blocked',
          resume_reason: 'planner_context_length_exceeded',
          failure_kind: 'token_budget_exceeded',
          blocked_reason: blockedReason,
          created_cards: [],
          updated_cards: [],
        },
      },
    });

    await runtime.startup();
    await runtime.dispatchGoal('project');

    const messages = getSessionMessages(saivageDir, 'planner:project');
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe('context_compaction');
    expect(messages[0].content).toContain('PERSISTED PLANNER SESSION HISTORY COMPACTED');
    expect(messages[0].content).toContain('recent_message_summaries');
    expect(messages[0].content).not.toContain('oversized-history-body '.repeat(20));
    const project = runtime.cardStore.read('project');
    expect(project?.status).not.toBe('blocked');
    expect(project?.error).toBeNull();
    expect(project?.result?.planning).toEqual(
      expect.objectContaining({
        status: 'continue',
        persisted_history_compacted: true,
        previous_failure_kind: 'token_budget_exceeded',
      }),
    );
    expect(fakeAgent.capturedPrompt).toContain('Parent Resume Context');
    expect(fakeAgent.capturedPrompt).toContain('resume_reason');
    expect(runtime.cardStore.read('next-safe-work')?.parent).toBe('project');
  });

  it('explicit start_project retries a blocked token-budget project after clearing stale planning metadata', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContinuePlannerCapturingAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    runtime = new Runtime(
      { projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'unused' }, fixtureDir } },
      fakeAgent,
    );
    const blockedReason =
      'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    runtime.cardStore.update('project', {
      status: 'blocked',
      error: blockedReason,
      status_text: blockedReason,
      result: {
        planning: {
          status: 'blocked',
          resume_reason: 'planner_context_length_exceeded',
          failure_kind: 'token_budget_exceeded',
          blocked_reason: blockedReason,
          created_cards: [],
          updated_cards: [],
        },
      },
    });

    await runtime.startup();
    const startResult = await runtime.startProject('operator');
    expect(startResult.success).toBe(true);
    for (let attempt = 0; attempt < 20 && runtime.getBackgroundDispatchCount() > 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));

    const project = runtime.cardStore.read('project');
    expect(project?.status).not.toBe('blocked');
    expect(project?.error).toBeNull();
    expect(project?.status_text).toBeNull();
    expect(project?.result?.planning).toEqual(
      expect.objectContaining({
        status: 'continue',
      }),
    );
    expect(project?.result?.planning).not.toEqual(
      expect.objectContaining({
        resume_reason: 'planner_context_length_exceeded',
        failure_kind: 'token_budget_exceeded',
      }),
    );
    expect(runtime.cardStore.read('next-safe-work')?.parent).toBe('project');
  });

  it('runtime source start_project still does not retry a blocked token-budget project automatically', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContinuePlannerCapturingAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    runtime = new Runtime(
      { projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'unused' }, fixtureDir } },
      fakeAgent,
    );
    const blockedReason =
      'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    runtime.cardStore.update('project', {
      status: 'blocked',
      error: blockedReason,
      status_text: blockedReason,
      result: {
        planning: {
          status: 'blocked',
          resume_reason: 'planner_context_length_exceeded',
          failure_kind: 'token_budget_exceeded',
          blocked_reason: blockedReason,
          created_cards: [],
          updated_cards: [],
        },
      },
    });
    updateRuntimeState(tmpDir, {
      status: 'idle',
      current_card_id: null,
      current_agent_session_id: null,
      active_card_run: null,
      runtime_intent: {
        status: 'running',
        updated_at: new Date().toISOString(),
        source_command_id: 'cmd-old',
        reason: 'stale running intent should not automatically retry token-budget blocker',
      },
      runtime_runs: [],
    });

    await runtime.startup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const startResult = await runtime.startProject('runtime');

    expect(startResult.success).toBe(false);
    expect(runtime.cardStore.read('project')?.status).toBe('blocked');
    expect(runtime.cardStore.read('next-safe-work')).toBeNull();
    expect(runtime.getBackgroundDispatchCount()).toBe(0);
  });

  it('allows explicit retry of a persisted context-length blocker to surface a newer precise planner blocker', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new DonePlannerWithPassingReviewerAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    runtime = new Runtime(
      { projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'unused' }, fixtureDir } },
      fakeAgent,
    );
    const blockedReason =
      'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    runtime.cardStore.update('project', {
      status: 'active',
      error: blockedReason,
      status_text: blockedReason,
      result: {
        planning: {
          status: 'blocked',
          resume_reason: 'planner_context_length_exceeded',
          failure_kind: 'token_budget_exceeded',
          blocked_reason: blockedReason,
          created_cards: [],
          updated_cards: [],
        },
      },
    });

    await runtime.startup();
    await runtime.dispatchGoal('project');

    const project = runtime.cardStore.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.error).toContain(
      'Project planner returned done without creating/updating cards',
    );
    expect(project?.status_text).toContain(
      'Project planner returned done without creating/updating cards',
    );
    expect(project?.result?.planning).toEqual(
      expect.objectContaining({
        status: 'blocked',
        resume_reason: 'non_actionable_project_done',
        planner_declared_done: true,
      }),
    );
    expect(project?.result?.planning).not.toEqual(
      expect.objectContaining({
        resume_reason: 'planner_context_length_exceeded',
        failure_kind: 'token_budget_exceeded',
      }),
    );
    expect(project?.result?.review).toBeUndefined();
    expect(runtime.getState()?.status).toBe('idle');
    expect(runtime.getState()?.active_card_run).toBeNull();
    expect(runtime.getState()?.current_card_id).toBeNull();
  });
});
