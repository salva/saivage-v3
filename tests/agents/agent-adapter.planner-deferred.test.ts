import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import type { LlmCallFn, LlmCompleteResult } from '../../src/agents/llm-contracts.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import { getSessionMessages } from '../../src/agents/session-persistence.js';
import type { AgentToolMessage } from '../../src/agents/agent-tool-executor.js';

function config(): SaivageConfig {
  return ({
    models: { planner: ['m1'], executor: ['m1'], reviewer: ['m1'], analyst: ['m1'] },
    providers: {
      p1: { priority: 10, models: ['m1'], capabilities: { toolsMode: 'native', exclusiveToolChoiceSupport: 'native' } },
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
      maxToolTurns: 16,
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
  } as unknown) as SaivageConfig;
}

describe('AgentAdapter planner deferred-activation flow', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-planner-deferred-'));
    mkdirSync(join(root, '.saivage'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('emits activate_card then emit_planner_deferred and projects to deferred typed result', async () => {
    const adapter = new AgentAdapter({ projectRoot: root, saivageDir: join(root, '.saivage'), config: config() });

    (adapter as unknown as { toolExecutor: { processToolCall: (...args: unknown[]) => Promise<AgentToolMessage> } }).toolExecutor.processToolCall = jest.fn(async (
      tc: { id: string; function: { name: string; arguments: string } },
    ): Promise<AgentToolMessage> => ({
      role: 'tool',
      kind: 'tool_result',
      content: JSON.stringify({ success: true, child_card_id: 'child-1', parent_card_id: 'goal-1' }),
      tool: tc.function.name,
      tool_call_id: tc.id,
    })) as never;

    const deferredEnvelope = {
      kind: 'deferred_activate_card',
      version: 1,
      parent_card_id: 'goal-1',
      child_card_id: 'child-1',
      planner_session_id: 'planner:goal-1',
      tool_call_id: 'call-activate',
      requested_at: '2026-01-01T00:00:00.000Z',
    };

    let turn = 0;
    const llmCall = jest.fn<LlmCallFn>(async (): Promise<LlmCompleteResult> => {
      turn += 1;
      if (turn === 1) {
        return {
          kind: 'tool_calls',
          tool_calls: [{ id: 'call-activate', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ cardId: 'child-1' }) } }],
        };
      }
      return {
        kind: 'tool_calls',
        tool_calls: [{ id: 'call-deferred', type: 'function', function: { name: 'emit_planner_deferred', arguments: JSON.stringify(deferredEnvelope) } }],
      };
    });
    adapter.setLlmCallFn(llmCall);

    const result = await adapter.invokePlanner('goal-1', 'prompt');

    expect(result.status).toBe('continue');
    expect(result.summary).toContain('child-1');
    expect(llmCall).toHaveBeenCalledTimes(2);

    const messages = getSessionMessages(join(root, '.saivage'), 'planner:goal-1');
    const toolCallNames = messages
      .filter((m) => m.role === 'assistant' && m.kind === 'tool_call')
      .map((m) => m.tool);
    expect(toolCallNames).toContain('activate_card');
    expect(toolCallNames).toContain('emit_planner_deferred');
  });
});
