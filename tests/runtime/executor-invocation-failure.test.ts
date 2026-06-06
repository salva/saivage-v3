import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentExecutionPort } from '../../src/contracts/index.js';
import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { ExecutorActivationDispatcher } from '../../src/runtime/executor-activation-dispatcher.js';
import { createRuntimeStateMutationPort } from '../../src/runtime/mutations.js';
import { handleExecutorInvocationFailure, type ExecutorInvocationFailureEffects } from '../../src/runtime/phases/executor-invocation-failure.js';
import { appendRuntimeRun, initRuntimeState, readRuntimeState, updateRuntimeState, upsertRuntimeActivation } from '../../src/runtime/state.js';
import type { RuntimeCardAction } from '../../src/runtime/state-machine.js';
import type { CardRecord } from '../../src/schemas/index.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';

describe('executor invocation failure handler', () => {
  it('fails the card, appends unwind result, clears active run, and emits card_failed', async () => {
    const calls: string[] = [];
    await handleExecutorInvocationFailure({
      card: executorCard('code-a'),
      cardId: 'code-a',
      goalId: 'goal-a',
      error: new Error('executor exploded'),
      effects: testEffects({
        transitionCard: async (cardId, event, details) => { calls.push(`${event}:${cardId}:${details.reason}`); },
        appendChildUnwindToolResult: (cardId, outcome, summary) => { calls.push(`unwind:${cardId}:${outcome}:${summary}`); },
        clearActiveCardRun: (cardId) => { calls.push(`clear:${cardId}`); },
        emitCardFailed: (cardId, goalId) => { calls.push(`failed:${cardId}:${goalId}`); },
      }),
    });

    expect(calls).toEqual([
      'fail:code-a:executor_exception',
      'unwind:code-a:failed:Terminal card code-a execution failed before producing a result.',
      'clear:code-a',
      'failed:code-a:goal-a',
    ]);
  });

  it('clears active executor run immediately after dispatcher catches invocation failure', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-executor-invocation-failure-'));
    try {
      initProjectTree(projectRoot);
      initRuntimeState(projectRoot);
      materializeProjectCard(projectRoot);
      const cards = new CardStore(projectRoot);
      const codeCard = cards.create({
        type: 'code',
        parent: 'project',
        depth: 1,
        title: 'Code A',
        description: 'Do code work',
        status: 'backlog',
        depends_on: [],
        priority: 1,
        tags: [],
        urgency: 'normal',
        created_by: 'planner',
        blocks: [],
        related: [],
        acceptance: '',
        artifacts: [],
        attachments: [],
        retries: 0,
      });
      const parentRun = appendRuntimeRun(projectRoot, { run_id: 'run-parent', kind: 'root', card_id: 'project', parent_run_id: null, command_id: null, activation_id: null, phase: 'planner', runtime_status: 'running', session_id: 'planner:project' });
      const codeCardId = codeCard.id;
      const childRun = appendRuntimeRun(projectRoot, { run_id: 'run-child', kind: 'child', card_id: codeCardId, parent_run_id: parentRun.run_id, command_id: null, activation_id: null, phase: 'executor', runtime_status: 'running', session_id: `executor-${codeCardId}` });
      upsertRuntimeActivation(projectRoot, {
        idempotency_key: `run-parent:call-a:${codeCardId}`,
        parent_card_id: 'project',
        parent_run_id: parentRun.run_id,
        parent_session_id: 'planner:project',
        parent_tool_call_id: 'call-a',
        child_card_id: codeCardId,
        status: 'running',
        precondition: 'accepted',
        runtime_run_id: childRun.run_id,
        error: null,
      });
      updateRuntimeState(projectRoot, {
        status: 'running',
        current_card_id: codeCardId,
        current_agent_session_id: `executor-${codeCardId}`,
        active_card_run: {
          card_id: codeCardId,
          card_type: 'code',
          phase: 'executor',
          runtime_status: 'running',
          caller_session_id: 'planner:project',
          caller_tool_call_id: 'call-a',
          executor_session_id: `executor-${codeCardId}`,
          correction_attempts: 0,
          started_at: '2026-01-01T00:00:00.000Z',
          last_turn_at: '2026-01-01T00:00:00.000Z',
        },
      });
      const failureToolResults: Array<{ cardId: string; outcome: string; summary: string }> = [];
      const mutations = createRuntimeStateMutationPort(projectRoot);
      const now = () => '2026-01-01T00:01:00.000Z';
      const dispatcher = new ExecutorActivationDispatcher({
        projectRoot,
        cards,
        agentRuntime: failingAgentRuntime(),
        skillsEngine: null,
        activationUnwind: {
          appendChildUnwindToolResult: (cardId: string, outcome: 'failed', summary: string) => {
            failureToolResults.push({ cardId, outcome, summary });
          },
        },
        mutations,
        now,
        emit: () => undefined,
        emitRuntimeDiagnostic: () => undefined,
        eventLogger: { appendEvent: () => undefined },
        errorLogger: { appendError: () => undefined },
        stateMachine: {
          transitionCard: async (cardId: string, action: RuntimeCardAction, details: Record<string, unknown>) => {
            if (action === 'start') {
              cards.setStatus(cardId, 'active');
              cards.setStatus(cardId, 'running');
              return true;
            }
            if (action === 'fail') {
              const error = typeof details.error === 'string' ? details.error : 'executor failed';
              cards.commitTerminalLifecyclePatch(cardId, {
                status: 'failed',
                lifecycle: {
                  status: 'failed',
                  result: { kind: 'executor_failure', error, partial_result: null, latest_self_report: { result: 'failed', outcome: 'failed', summary: error, status_text: 'failed', at: now() } },
                  error,
                  completed_at: now(),
                },
              });
              return true;
            }
            return false;
          },
        },
      } as never);

      await expect(dispatcher.dispatch({ goalId: 'project', goalCard: cards.read('project'), card: codeCard, callerEdge: { parentCardId: 'project', callerSessionId: 'planner:project', callerToolCallId: 'call-a' } })).resolves.toEqual({ executedTerminal: false, failed: true });

      const state = readRuntimeState(projectRoot);
      expect(state?.active_card_run).toBeNull();
      expect(state?.current_card_id).toBeNull();
      expect(state?.current_agent_session_id).toBeNull();
      expect((cards.read(codeCardId) as CardRecord).status).toBe('failed');
      expect(failureToolResults).toEqual([
        { cardId: codeCardId, outcome: 'failed', summary: `Terminal card ${codeCardId} execution failed before producing a result.` },
      ]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

function testEffects(overrides: Partial<ExecutorInvocationFailureEffects> = {}): ExecutorInvocationFailureEffects {
  return {
    emitRuntimeDiagnostic: () => undefined,
    appendRuntimeDiagnostic: () => undefined,
    appendError: () => undefined,
    transitionCard: async () => undefined,
    updateCard: () => undefined,
    appendChildUnwindToolResult: () => undefined,
    clearActiveCardRun: () => undefined,
    emitCardFailed: () => undefined,
    now: () => '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function executorCard(id: string): CardRecord {
  return {
    id,
    type: 'code',
    parent: 'goal-a',
    depth: 1,
    title: 'Code A',
    description: 'Do code work',
    status: 'running',
    depends_on: [],
    priority: 1,
    tags: [],
    urgency: 'normal',
    created_by: 'planner',
    blocks: [],
    related: [],
    acceptance: '',
    artifacts: [],
    attachments: [],
    retries: 0,
    lifecycle: { status: 'running', result: null, error: null, completed_at: null },
  } as unknown as CardRecord;
}

function failingAgentRuntime(): AgentExecutionPort {
  return {
    invokePlanner: () => ({ status: 'done' }),
    invokeExecutor: () => { throw new Error('executor exploded'); },
    invokeReviewer: () => ({ assessment: { result: 'pass', summary: 'ok', achieved: [], issues: [], evidence_card_ids: [] } }),
    cancelSession: () => false,
    forceCancelSession: () => false,
    getHandoffSummary: () => null,
    getActiveSessionHandoffs: () => [],
  };
}
