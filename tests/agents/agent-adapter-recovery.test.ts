import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import type { LlmCallFn } from '../../src/agents/llm-contracts.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import { LlmAuthError, LlmServerError } from '../../src/agents/llm-errors.js';
import { getSession, getSessionMessages, listSessions } from '../../src/agents/session-persistence.js';

function config(): SaivageConfig {
  return {
    models: { planner: ['m1', 'm2'], executor: ['m1', 'm2'], reviewer: ['m1'], analyst: ['m1'] },
    providers: {
      p1: { priority: 10, models: ['m1'], capabilities: { toolCalls: 'native', toolChoice: 'auto' } },
      p2: { priority: 20, models: ['m2'], capabilities: { toolCalls: 'native', toolChoice: 'auto' } },
    },
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
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
  } as SaivageConfig;
}

function makeAdapter(root: string, cfg = config()): AgentAdapter {
  return new AgentAdapter({ projectRoot: root, saivageDir: join(root, '.saivage'), config: cfg });
}

function plannerDone(status: 'continue' | 'done' = 'done'): string {
  return JSON.stringify({ created_cards: [], updated_cards: [], status });
}

describe('AgentAdapter invocation recovery policy integration', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-adapter-recovery-'));
    mkdirSync(join(root, '.saivage'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('does not mark auth failures as provider health failures and fails over to next candidate', async () => {
    const adapter = makeAdapter(root);
    const markFailed = jest.spyOn(adapter.getRegistry(), 'markFailed');
    const llmCall = jest.fn<LlmCallFn>()
      .mockRejectedValueOnce(new LlmAuthError('api_key=sk-syntheticSECRET123456 rejected'))
      .mockResolvedValueOnce(plannerDone());
    adapter.setLlmCallFn(llmCall);

    const result = await adapter.invokePlanner('goal-1', 'prompt');

    expect(result.status).toBe('done');
    expect(markFailed).not.toHaveBeenCalled();
    expect(adapter.getRegistry().getHealth({ provider: 'p1', account: null, model: 'm1' }).failureCount).toBe(0);
    const messages = getSessionMessages(join(root, '.saivage'), listSessions(join(root, '.saivage'))[0]);
    const issue = messages.find((message) => message.kind === 'model_issue');
    expect(issue?.content).toContain('auth error');
    expect(issue?.content).not.toContain('sk-syntheticSECRET123456');
  });

  it('retries parse/contract failures on the same candidate without using fallback', async () => {
    const cfg = config();
    cfg.runtime.maxRecoveryRetries = 1;
    cfg.runtime.recoveryDelayMs = 0;
    const adapter = makeAdapter(root, cfg);
    const markFailed = jest.spyOn(adapter.getRegistry(), 'markFailed');
    const seen: string[] = [];
    const llmCall = jest.fn<LlmCallFn>(async (candidate) => {
      seen.push(candidate.provider);
      if (seen.length === 1) return '{"created_cards":[],"updated_cards":[],"status":"not-a-valid-status"}';
      return plannerDone();
    });
    adapter.setLlmCallFn(llmCall);

    const result = await adapter.invokePlanner('goal-1', 'prompt');

    expect(result.status).toBe('done');
    expect(seen).toEqual(['p1', 'p1']);
    expect(llmCall).toHaveBeenCalledTimes(2);
    expect(markFailed).not.toHaveBeenCalled();
    expect(adapter.getRegistry().getHealth({ provider: 'p1', account: null, model: 'm1' }).failureCount).toBe(0);
    expect(adapter.getRegistry().getHealth({ provider: 'p2', account: null, model: 'm2' }).failureCount).toBe(0);
  });

  it('marks transient server failures failed with cooldown before fallback succeeds', async () => {
    const adapter = makeAdapter(root);
    const markFailed = jest.spyOn(adapter.getRegistry(), 'markFailed');
    adapter.setLlmCallFn(jest.fn<LlmCallFn>()
      .mockRejectedValueOnce(new LlmServerError('upstream unavailable'))
      .mockResolvedValueOnce(plannerDone()));

    await expect(adapter.invokePlanner('goal-1', 'prompt')).resolves.toMatchObject({ status: 'done' });

    expect(markFailed).toHaveBeenCalledWith({ provider: 'p1', account: null, model: 'm1' }, 1);
    expect(adapter.getRegistry().getHealth({ provider: 'p1', account: null, model: 'm1' }).failureCount).toBe(1);
  });

  it('marks planner continue results as waiting rather than done', async () => {
    const adapter = makeAdapter(root);
    adapter.setLlmCallFn(jest.fn<LlmCallFn>().mockResolvedValue(plannerDone('continue')));

    await expect(adapter.invokePlanner('goal-1', 'prompt')).resolves.toMatchObject({ status: 'continue' });

    const sessionId = listSessions(join(root, '.saivage'))[0];
    expect(getSession(join(root, '.saivage'), sessionId)).toMatchObject({ status: 'waiting', completed_at: null });
  });

  it('does not mark capability mismatch or fallback exhaustion as health failure', async () => {
    const cfg = config();
    cfg.providers.p1.capabilities = { toolCalls: 'none', toolChoice: 'none' };
    cfg.providers.p2.capabilities = { toolCalls: 'none', toolChoice: 'none' };
    const adapter = makeAdapter(root, cfg);
    const markFailed = jest.spyOn(adapter.getRegistry(), 'markFailed');
    adapter.setLlmCallFn(jest.fn<LlmCallFn>().mockResolvedValue(plannerDone()));

    await expect(adapter.invokePlanner('goal-1', 'prompt')).rejects.toThrow('No capability-compatible candidates');

    expect(markFailed).not.toHaveBeenCalled();
    expect(adapter.getRegistry().getHealth({ provider: 'p1', account: null, model: 'm1' }).failureCount).toBe(0);
  });

  it('preserves provider fallback behavior after unknown candidate errors', async () => {
    const adapter = makeAdapter(root);
    const seen: string[] = [];
    adapter.setLlmCallFn(jest.fn<LlmCallFn>(async (candidate) => {
      seen.push(candidate.provider);
      if (candidate.provider === 'p1') throw new Error('unknown transport fault');
      return plannerDone();
    }));

    const result = await adapter.invokePlanner('goal-1', 'prompt');

    expect(result.status).toBe('done');
    expect(seen).toEqual(['p1', 'p2']);
    expect(adapter.getRegistry().getHealth({ provider: 'p1', account: null, model: 'm1' }).failureCount).toBe(1);
  });
});
