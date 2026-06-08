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
import { FakeAgentAdapter } from '../../src/runtime/fake-agent.js';
import { LlmRequestError } from '../../src/agents/llm-errors.js';
import { releaseLock } from '../../src/runtime/lock.js';
import { deriveCurrentCardId } from '../../src/runtime/current-run.js';
import type {
  PlannerInvocationRequest,
  PlannerResult,
  ReviewerResult,
} from '../../src/contracts/index.js';
import { createRuntimeCoreTestContainer, type RuntimeCoreTestContainer } from '../../src/runtime/core-composition.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';
import type { CardRecord, CardStatus } from '../../src/schemas/index.js';

function plannerBlockedPatch(
  status: Extract<CardStatus, 'running' | 'blocked'>,
  blockedReason: string,
  resumeReason: string,
): Partial<CardRecord> {
  return {
    status,
    lifecycle: {
      status,
      result: { kind: 'planner_blocked', blocked_reason: blockedReason, resume_reason: resumeReason },
      error: blockedReason,
      completed_at: null,
    },
    status_text: blockedReason,
  };
}

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

class ContinuePlannerCapturingAdapter extends FakeAgentAdapter {
  capturedPrompt = '';
  private invoked = false;

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
    this.invoked = true;
    return {
      status: 'continue',
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
  let harness: RuntimeCoreTestContainer;

  function createHarness(fakeAgent: FakeAgentAdapter): RuntimeCoreTestContainer {
    const fixtureDir = join(tmpDir, 'fixtures');
    return createRuntimeCoreTestContainer({
      config: { projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'unused' }, fixtureDir } },
      agentRuntime: fakeAgent,
    });
  }

  function createRuntime(fakeAgent: FakeAgentAdapter): void {
    harness = createHarness(fakeAgent);
  }

  function createNextSafeWork(): CardRecord {
    return harness.cardTestTools.create({
      type: 'code',
      parent: 'project',
      depth: 1,
      title: 'Next safe work',
      description: '',
      status: 'backlog',
      tags: [],
      priority: 0,
      urgency: 'normal',
      created_by: 'planner',
      depends_on: [],
      related: [],
      artifacts: [],
      attachments: [],
      acceptance: '',
      retries: 0,
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-planner-context-length-'));
    mkdirSync(join(tmpDir, 'fixtures'), { recursive: true });
    initProjectTree(tmpDir);
    materializeProjectCard(tmpDir);
  });

  afterEach(async () => {
    if (harness) {
      try {
        await harness.api.shutdown();
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
    createRuntime(fakeAgent);

    await harness.api.start();
    await expect(harness.dispatchTestTools.dispatchGoal('project')).resolves.toBeUndefined();

    const project = harness.cardTestTools.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.lifecycle.error).toContain('Planner context exceeded');
    expect(project?.lifecycle.result).toEqual(
      expect.objectContaining({
        resume_reason: 'planner_context_length_exceeded',
      }),
    );
    expect(harness.stateTestTools.read()?.active_card_run).toBeNull();
    expect(deriveCurrentCardId(harness.stateTestTools.read())).toBeNull();
  });

  it('aligns active/running card status with persisted context-length planning blockers on startup', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContextLengthPlannerAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    createRuntime(fakeAgent);
    const blockedReason =
      'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    harness.cardTestTools.repairTerminalLifecycle('project', {
      ...plannerBlockedPatch('running', blockedReason, 'planner_context_length_exceeded'),
    });
    updateRuntimeState(tmpDir, {
      status: 'running',
      active_card_run: {
        card_id: 'project',
        card_type: 'project',
        ownership: { kind: 'direct', source: 'project_root' },
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

    await harness.api.start();

    const project = harness.cardTestTools.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.status_text).toBe(blockedReason);
    expect(project?.lifecycle.result).toEqual(
      expect.objectContaining({
        resume_reason: 'planner_context_length_exceeded',
      }),
    );
    expect(harness.stateTestTools.read()?.status).toBe('idle');
    expect(deriveCurrentCardId(harness.stateTestTools.read())).toBeNull();
    expect(harness.stateTestTools.read()?.active_card_run).toBeNull();
  });

  it('does not redispatch a persisted blocked planning card on startup', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContextLengthPlannerAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    createRuntime(fakeAgent);
    const blockedReason =
      'planner remains durably blocked until an explicit operator or state change';
    harness.cardTestTools.repairTerminalLifecycle('project', {
      ...plannerBlockedPatch('blocked', blockedReason, 'planner_context_length_exceeded'),
    });
    updateRuntimeState(tmpDir, {
      status: 'running',
      active_card_run: {
        card_id: 'project',
        card_type: 'project',
        ownership: { kind: 'direct', source: 'project_root' },
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

    await harness.api.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.lifecycleTestTools.requestImmediateTick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const project = harness.cardTestTools.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.lifecycle.error).toBe(blockedReason);
    expect(project?.lifecycle.result).toEqual(
      expect.objectContaining({
        resume_reason: 'planner_context_length_exceeded',
      }),
    );
    expect(harness.stateTestTools.read()?.status).toBe('idle');
    expect(deriveCurrentCardId(harness.stateTestTools.read())).toBeNull();
    expect(harness.stateTestTools.read()?.active_card_run).toBeNull();
    expect(harness.diagnosticTestTools.getBackgroundDispatchCount()).toBe(0);
  });

  it('aligns done project status with persisted precise planning blockers on startup', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContextLengthPlannerAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    createRuntime(fakeAgent);
    const blockedReason =
      'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    harness.cardTestTools.repairTerminalLifecycle('project', {
      ...plannerBlockedPatch('blocked', blockedReason, 'planner_context_length_exceeded'),
    });

    await harness.api.start();

    const project = harness.cardTestTools.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.lifecycle.error).toBe(blockedReason);
    expect(project?.status_text).toBe(blockedReason);
    expect(project?.lifecycle.result).toEqual(
      expect.objectContaining({
        resume_reason: 'planner_context_length_exceeded',
      }),
    );
    expect(harness.stateTestTools.read()?.status).toBe('idle');
    expect(deriveCurrentCardId(harness.stateTestTools.read())).toBeNull();
    expect(harness.stateTestTools.read()?.active_card_run).toBeNull();
  });

  it('does not restart running intent when the project has a durable planning blocker', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContextLengthPlannerAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    createRuntime(fakeAgent);
    const blockedReason =
      'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    harness.cardTestTools.repairTerminalLifecycle('project', {
      ...plannerBlockedPatch('blocked', blockedReason, 'planner_context_length_exceeded'),
    });
    updateRuntimeState(tmpDir, {
      status: 'idle',
      active_card_run: null,
      runtime_intent: {
        status: 'running',
        updated_at: new Date().toISOString(),
        source_command_id: 'cmd-old',
        reason: 'continuous runtime intent should not bypass durable blocker',
      },
      runtime_runs: [],
    });

    await harness.api.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const project = harness.cardTestTools.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.lifecycle.result).toEqual(
      expect.objectContaining({
        resume_reason: 'planner_context_length_exceeded',
      }),
    );
    expect(harness.stateTestTools.read()?.status).toBe('idle');
    expect(deriveCurrentCardId(harness.stateTestTools.read())).toBeNull();
    expect(harness.stateTestTools.read()?.active_card_run).toBeNull();
    expect(harness.stateTestTools.read()?.runtime_runs ?? []).toHaveLength(0);
    expect(harness.diagnosticTestTools.getBackgroundDispatchCount()).toBe(0);
  });

  it('compacts oversized persisted planner history and clears stale token-budget blocker before retry', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContinuePlannerCapturingAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    createRuntime(fakeAgent);
    const nextSafeWork = createNextSafeWork();
    const saivageDir = join(tmpDir, '.saivage');
    createSession(saivageDir, 'planner', 'project', 'project', undefined, 'planner:project');
    for (let index = 0; index < 40; index += 1) {
      appendMessage(
        saivageDir,
        'planner:project',
        {
          role: index % 2 === 0 ? 'user' : 'assistant',
          kind: index % 5 === 0 ? 'tool_result' : 'text',
          tool: index % 5 === 0 ? 'read' : undefined,
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
    harness.cardTestTools.repairTerminalLifecycle('project', {
      ...plannerBlockedPatch('blocked', blockedReason, 'planner_context_length_exceeded'),
    });

    await harness.api.start();
    await harness.dispatchTestTools.dispatchGoal('project');

    const messages = getSessionMessages(saivageDir, 'planner:project');
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe('context_compaction');
    expect(messages[0].content).toContain('PERSISTED PLANNER SESSION HISTORY COMPACTED');
    expect(messages[0].content).toContain('recent_message_summaries');
    expect(messages[0].content).not.toContain('oversized-history-body '.repeat(20));
    const project = harness.cardTestTools.read('project');
    expect(project?.status).not.toBe('blocked');
    expect(project?.lifecycle.error).toBeNull();
    expect(project?.lifecycle.result).toBeNull();
    expect(fakeAgent.capturedPrompt).toContain('Parent Resume Context');
    expect(fakeAgent.capturedPrompt).toContain('resume_reason');
    expect(harness.cardTestTools.read(nextSafeWork.id)?.parent).toBe('project');
  });

  it('explicit start_project retries a blocked token-budget project after clearing stale planning metadata', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContinuePlannerCapturingAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    createRuntime(fakeAgent);
    const nextSafeWork = createNextSafeWork();
    const blockedReason =
      'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    harness.cardTestTools.repairTerminalLifecycle('project', {
      ...plannerBlockedPatch('blocked', blockedReason, 'planner_context_length_exceeded'),
    });

    await harness.api.start();
    const startResult = await harness.api.startProject('operator');
    expect(startResult.success).toBe(true);
    for (let attempt = 0; attempt < 20 && harness.diagnosticTestTools.getBackgroundDispatchCount() > 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));

    const project = harness.cardTestTools.read('project');
    expect(project?.status).not.toBe('blocked');
    expect(project?.lifecycle.error).toBeNull();
    expect(project?.lifecycle.result).toBeNull();
    expect(harness.cardTestTools.read(nextSafeWork.id)?.parent).toBe('project');
  });

  it('runtime source start_project still does not retry a blocked token-budget project automatically', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContinuePlannerCapturingAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    createRuntime(fakeAgent);
    const blockedReason =
      'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    harness.cardTestTools.repairTerminalLifecycle('project', {
      ...plannerBlockedPatch('blocked', blockedReason, 'planner_context_length_exceeded'),
    });
    updateRuntimeState(tmpDir, {
      status: 'idle',
      active_card_run: null,
      runtime_intent: {
        status: 'running',
        updated_at: new Date().toISOString(),
        source_command_id: 'cmd-old',
        reason: 'stale running intent should not automatically retry token-budget blocker',
      },
      runtime_runs: [],
    });

    await harness.api.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const startResult = await harness.api.startProject('runtime');

    expect(startResult.success).toBe(false);
    expect(harness.cardTestTools.read('project')?.status).toBe('blocked');
    expect(harness.diagnosticTestTools.getBackgroundDispatchCount()).toBe(0);
  });

  it('allows explicit retry of a persisted context-length blocker to surface a newer precise planner blocker', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new DonePlannerWithPassingReviewerAdapter({
      mapping: { project: 'unused' },
      fixtureDir,
    });
    createRuntime(fakeAgent);
    const blockedReason =
      'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    harness.cardTestTools.repairTerminalLifecycle('project', {
      ...plannerBlockedPatch('running', blockedReason, 'planner_context_length_exceeded'),
    });
    updateRuntimeState(tmpDir, {
      runtime_runs: [{
        run_id: 'run-interrupted-project-planner',
        kind: 'root',
        card_id: 'project',
        ownership: { kind: 'direct', source: 'project_root' },
        parent_run_id: null,
        command_id: null,
        activation_id: null,
        phase: 'planner',
        runtime_status: 'running',
        session_id: 'planner:project',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    });

    await harness.api.start();
    await harness.dispatchTestTools.dispatchGoal('project');

    const project = harness.cardTestTools.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.lifecycle.result).toEqual(
      expect.objectContaining({
        resume_reason: 'non_actionable_project_done',
      }),
    );
    expect(project?.lifecycle.result).not.toEqual(
      expect.objectContaining({
        resume_reason: 'planner_context_length_exceeded',
      }),
    );
    expect(harness.stateTestTools.read()?.status).toBe('idle');
    expect(harness.stateTestTools.read()?.active_card_run).toBeNull();
    expect(deriveCurrentCardId(harness.stateTestTools.read())).toBeNull();
  });
});
