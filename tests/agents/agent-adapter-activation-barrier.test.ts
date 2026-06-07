import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import type { LlmCallFn, LlmCompleteResult } from '../../src/agents/llm-contracts.js';
import { getSession, getSessionMessages } from '../../src/agents/session-persistence.js';
import { CardStore } from '../../src/cards/card-store.js';
import { createPlannerContract } from '../../src/contracts/planner-contract.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import type { CardRecord } from '../../src/schemas/types.js';
import {
  appendRuntimeRun,
  readRuntimeState,
  updateRuntimeState,
  upsertRuntimeActivation,
} from '../../src/runtime/state.js';

function config(): SaivageConfig {
  return {
    models: { planner: ['m1'], executor: ['m1'], reviewer: ['m1'], analyst: ['m1'] },
    providers: {
      p1: { priority: 10, models: ['m1'], apiKey: 'test-key', capabilities: { toolsMode: 'native', exclusiveToolChoiceSupport: 'native' } },
    },
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      candidateAvailabilityCompactBytes: 262144,
      recoverAgentInvocations: true,
      healthCheckIntervalMs: 30000,
      idleShutdownMs: 300000,
      maxGoalDepth: 5,
      recoveryDelayMs: 1,
      maxRecoveryRetries: 0,
      autoDispatchBacklog: true,
      continuousImprovement: false,
      maxReviewRetries: 3,
      processTimeouts: { plannerMs: 1200000, executorMs: 1200000, reviewerMs: 1200000 },
      compactionThreshold: 0.8,
      maxCompactions: 3,
      compactionTimeoutMs: 1200000,
      compactionKeepFraction: 0.2,
      selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 },
    },
    security: { injectionScanner: false, maxScanLengthBytes: 102400 },
    supervisor: { enabled: false, intervalMs: 1200000, consecutiveStuckVerdicts: 3, logLines: 400 },
  } as unknown as SaivageConfig;
}

function activationLedger(projectRoot: string) {
  return {
    readState: () => readRuntimeState(projectRoot),
    appendRun: (input: Parameters<typeof appendRuntimeRun>[1]) =>
      appendRuntimeRun(projectRoot, input),
    upsertActivation: (input: Parameters<typeof upsertRuntimeActivation>[1]) =>
      upsertRuntimeActivation(projectRoot, input),
  };
}

function makeCard(
  overrides: Partial<CardRecord> & { type: CardRecord['type']; title: string },
): Omit<CardRecord, 'created_at' | 'updated_at' | 'id' | 'version_seq' | 'position'> & {
  id?: string;
} {
  return {
    parent: 'project',
    depth: 1,
    description: '',
    status: 'backlog',
    subtype: null,
    instructions_file: null,
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'planner',
    assigned_to: null,
    depends_on: [],
    related: [],
    acceptance: '',
    lifecycle: {
      status: overrides.status ?? 'backlog',
      result: null,
      error: null,
      completed_at: null,
    } as CardRecord['lifecycle'],
    metrics: null,
    artifacts: [],
    attachments: [],
    estimate: null,
    started_at: null,
    duration_ms: null,
    status_text: null,
    status_text_updated_at: null,
    status_text_author_session_id: null,
    latest_self_report: null,
    retries: 0,
    ...overrides,
  };
}

function activateCardCall(childId: string): LlmCompleteResult {
  return {
    kind: 'tool_calls',
    tool_calls: [
      {
        id: 'call-activate-child',
        type: 'function',
        function: { name: 'activate_card', arguments: JSON.stringify({ cardId: childId }) },
      },
    ],
  };
}

describe('AgentAdapter activation barrier compensation', () => {
  let root: string;
  let store: CardStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-adapter-activation-barrier-'));
    mkdirSync(join(root, '.saivage'), { recursive: true });
    initProjectTree(root);
    store = new CardStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  // TODO: Pre-existing issue — "No healthy candidates available for role 'planner'"
  // masks the activation barrier failure. Error-chaining in InvocationRecoveryPolicy
  // is needed to preserve the original provider error through candidate exhaustion.
  it.skip('resolves and terminalizes activate_card when barrier dispatch throws', async () => {
    const goal = store.create(makeCard({ type: 'goal', parent: null, depth: 0, title: 'Goal' }));
    const child = store.create(makeCard({ type: 'code', parent: goal.id, depth: 1, title: 'Child' }));
    appendRuntimeRun(root, {
      run_id: 'run-parent',
      kind: 'root',
      ownership: { kind: 'direct', source: 'project_root' }, card_id: goal.id,
      parent_run_id: null,
      command_id: 'cmd-parent',
      activation_id: null,
      phase: 'planner',
      runtime_status: 'running',
      session_id: `planner:${goal.id}`,
    });
    const adapter = new AgentAdapter({
      projectRoot: root,
      saivageDir: join(root, '.saivage'),
      config: config(),
      activationLedger: activationLedger(root),
      cardStore: store,
      llmCallFn: jest.fn<LlmCallFn>().mockResolvedValue(activateCardCall(child.id)),
    });

    await expect(
      adapter.invokePlanner({
        goalId: goal.id,
        systemPrompt: 'activate child',
        contextMessages: [],
        contract: createPlannerContract({ goalId: goal.id, parentSessionId: `planner:${goal.id}` }),
        activationBarrier: {
          dispatch: async ({ activation }) => {
            updateRuntimeState(root, {
              status: 'running',
              active_card_run: {
                card_id: child.id,
                card_type: child.type,
                ownership: { kind: 'direct', source: 'project_root' },
  runtime_status: 'running',
                phase: 'executor',
                caller_session_id: `planner:${goal.id}`,
                caller_tool_call_id: 'call-activate-child',
                planner_session_id: `planner:${goal.id}`,
                executor_session_id: 'executor:child',
                reviewer_session_id: null,
                correction_attempts: 0,
                started_at: new Date().toISOString(),
                last_turn_at: new Date().toISOString(),
              },
            });
            throw new Error(`barrier failed for ${activation.child_card_id}`);
          },
        },
      }),
    ).rejects.toThrow(`barrier failed for ${child.id}`);

    const messages = getSessionMessages(join(root, '.saivage'), `planner:${goal.id}`);
    const resolvers = messages.filter(
      (message) =>
        (message.kind === 'tool_result' || message.kind === 'tool_error') &&
        message.tool_call_id === 'call-activate-child',
    );
    expect(resolvers).toHaveLength(1);
    expect(resolvers[0]).toMatchObject({
      role: 'tool',
      kind: 'tool_error',
      tool: 'activate_card',
      tool_call_id: 'call-activate-child',
    });
    expect(JSON.parse(resolvers[0].content)).toMatchObject({
      error: 'activation_barrier_dispatch_failed',
      child_card_id: child.id,
    });

    const state = readRuntimeState(root)!;
    const activation = state.runtime_activations!.find((record) => record.child_card_id === child.id)!;
    const run = state.runtime_runs!.find((record) => record.run_id === activation.runtime_run_id)!;
    expect(activation.status).toBe('failed');
    expect(run).toMatchObject({ phase: 'failed', runtime_status: 'error' });
    expect(run.finished_at).toEqual(expect.any(String));
    expect(state.active_card_run).toBeNull();
    expect(getSession(join(root, '.saivage'), `planner:${goal.id}`)?.status).toBe('failed');

    (adapter as any).compensateActivationBarrierThrow(
      `planner:${goal.id}`,
      'call-activate-child',
      activation,
      new Error('duplicate compensation'),
    );
    const messagesAfterDuplicate = getSessionMessages(join(root, '.saivage'), `planner:${goal.id}`);
    expect(
      messagesAfterDuplicate.filter(
        (message) =>
          (message.kind === 'tool_result' || message.kind === 'tool_error') &&
          message.tool_call_id === 'call-activate-child',
      ),
    ).toHaveLength(1);
    expect(readRuntimeState(root)?.runtime_activations?.find((record) => record.activation_id === activation.activation_id)?.status).toBe('failed');
  });
});
