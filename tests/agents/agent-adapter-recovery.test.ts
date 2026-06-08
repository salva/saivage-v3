import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { SessionInvariantError } from '../../src/agents/agent-adapter.js';
import type { LlmCallFn } from '../../src/agents/llm-contracts.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import { createSession, getSession, getSessionMessages, listSessions } from '../../src/agents/session-persistence.js';
import { CardStore } from '../../src/cards/card-store.js';
import { createPlannerContract } from '../../src/contracts/planner-contract.js';

function config(): SaivageConfig {
  return ({
    models: { planner: ['m1', 'm2'], executor: ['m1', 'm2'], reviewer: ['m1'], analyst: ['m1'] },
    providers: {
      p1: { priority: 10, models: ['m1'], capabilities: { toolsMode: 'native', exclusiveToolChoiceSupport: 'native' } },
      p2: { priority: 20, models: ['m2'], capabilities: { toolsMode: 'native', exclusiveToolChoiceSupport: 'native' } },
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
  } as unknown) as SaivageConfig;
}

function makeAdapter(root: string, cfg = config(), llmCallFn?: LlmCallFn): AgentAdapter {
  return new AgentAdapter({ projectRoot: root, saivageDir: join(root, '.saivage'), config: cfg, cardStore: new CardStore(root), llmCallFn });
}

function plannerRequest(goalId: string, systemPrompt = 'prompt') {
  return {
    goalId,
    systemPrompt,
    contextMessages: [],
    contract: createPlannerContract(),
  };
}

import type { LlmCompleteResult } from '../../src/agents/llm-contracts.js';

function plannerDone(status: 'continue' | 'done' = 'done'): LlmCompleteResult {
  return {
    kind: 'tool_calls',
    tool_calls: [{
      id: 'call-pd',
      type: 'function',
      function: {
        name: 'emit_planner_result',
        arguments: JSON.stringify({ status, summary: 'done' }),
      },
    }],
  };
}

function plannerToolResult(tool_calls: { id: string; name: string; arguments: string }[]): LlmCompleteResult {
  return {
    kind: 'tool_calls',
    tool_calls: tool_calls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments } })),
  };
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
    const llmCall = jest.fn<LlmCallFn>()
      .mockRejectedValueOnce(new LlmRequestError({ kind: 'auth_permanent', provider: 'p1', status: 401, message: 'api_key=sk-syntheticSECRET123456 rejected' }))
      .mockResolvedValueOnce(plannerDone());
    const adapter = makeAdapter(root, config(), llmCall);
    const markFailed = jest.spyOn(adapter.candidateAvailability, 'markFailed');

    const result = await adapter.invokePlanner(plannerRequest('goal-1'));

    expect(result.status).toBe('done');
    expect(markFailed).toHaveBeenCalledWith({ provider: 'p1', account: null, model: 'm1' }, expect.objectContaining({ state: 'BLOCKED_UNTIL', reason: 'auth_permanent' }));
    expect(adapter.candidateAvailability.isAvailable({ provider: 'p1', account: null, model: 'm1' })).toBe(false);
    const messages = getSessionMessages(join(root, '.saivage'), listSessions(join(root, '.saivage'))[0]);
    const issue = messages.find((message) => message.kind === 'model_issue');
    expect(issue?.content).toContain('auth error');
    expect(issue?.content).not.toContain('sk-syntheticSECRET123456');
  });

  it('retries parse transport failures on the same candidate and injects an explicit recovery directive', async () => {
    const cfg = config();
    cfg.runtime.maxRecoveryRetries = 1;
    cfg.runtime.recoveryDelayMs = 0;
    const seen: string[] = [];
    let secondAttemptMessages: string[] = [];
    const llmCall = jest.fn<LlmCallFn>(async (candidate, _systemPrompt, messages): Promise<LlmCompleteResult> => {
      seen.push(candidate.provider);
      if (seen.length === 1) throw new LlmRequestError({ kind: 'parse_error', provider: candidate.provider, message: 'invalid json', bodyPreview: '{' });
      secondAttemptMessages = messages.map((message) => message.content);
      return plannerDone();
    });
    const adapter = makeAdapter(root, cfg, llmCall);
    const markFailed = jest.spyOn(adapter.candidateAvailability, 'markFailed');

    const result = await adapter.invokePlanner(plannerRequest('goal-1'));

    expect(result.status).toBe('done');
    expect(seen).toEqual(['p1', 'p1']);
    expect(llmCall).toHaveBeenCalledTimes(2);
    expect(secondAttemptMessages.some((content) => content.includes('RECOVERY DIRECTIVE'))).toBe(true);
    expect(secondAttemptMessages.some((content) => content.includes('from disk'))).toBe(false);
    expect(markFailed).not.toHaveBeenCalled();
    expect(adapter.candidateAvailability.isAvailable({ provider: 'p1', account: null, model: 'm1' })).toBe(true);
    expect(adapter.candidateAvailability.isAvailable({ provider: 'p2', account: null, model: 'm2' })).toBe(true);
  });

  it('marks transient server failures failed with cooldown before fallback succeeds', async () => {
    const adapter = makeAdapter(root, config(), jest.fn<LlmCallFn>()
      .mockRejectedValueOnce(new LlmRequestError({ kind: 'server_transient', provider: 'p1', status: 502, message: 'upstream unavailable' }))
      .mockResolvedValueOnce(plannerDone()));
    const markFailed = jest.spyOn(adapter.candidateAvailability, 'markFailed');

    await expect(adapter.invokePlanner(plannerRequest('goal-1'))).resolves.toMatchObject({ status: 'done' });

    expect(markFailed).toHaveBeenCalledWith({ provider: 'p1', account: null, model: 'm1' }, expect.objectContaining({ state: 'COOLING', reason: 'server_transient' }));
    expect(adapter.candidateAvailability.isAvailable({ provider: 'p1', account: null, model: 'm1' })).toBe(false);
  });

  it('marks planner continue results as waiting rather than done', async () => {
    const adapter = makeAdapter(root, config(), jest.fn<LlmCallFn>().mockResolvedValue(plannerDone('continue')));

    await expect(adapter.invokePlanner(plannerRequest('goal-1'))).resolves.toMatchObject({ status: 'continue' });

    const sessionId = listSessions(join(root, '.saivage'))[0];
    expect(getSession(join(root, '.saivage'), sessionId)).toMatchObject({ status: 'waiting', completed_at: null });
  });

  it('does not mark capability mismatch or fallback exhaustion as health failure', async () => {
    const cfg = config();
    cfg.providers.p1.capabilities = { toolsMode: 'unsupported', exclusiveToolChoiceSupport: 'unsupported' };
    cfg.providers.p2.capabilities = { toolsMode: 'unsupported', exclusiveToolChoiceSupport: 'unsupported' };
    const adapter = makeAdapter(root, cfg, jest.fn<LlmCallFn>().mockResolvedValue(plannerDone()));
    const markFailed = jest.spyOn(adapter.candidateAvailability, 'markFailed');

    await expect(adapter.invokePlanner(plannerRequest('goal-1'))).rejects.toThrow('No capability-compatible candidates');

    expect(markFailed).not.toHaveBeenCalled();
    expect(adapter.candidateAvailability.isAvailable({ provider: 'p1', account: null, model: 'm1' })).toBe(true);
  });

  it('preserves provider fallback behavior after unknown candidate errors', async () => {
    const seen: string[] = [];
    const adapter = makeAdapter(root, config(), jest.fn<LlmCallFn>(async (candidate): Promise<LlmCompleteResult> => {
      seen.push(candidate.provider);
      if (candidate.provider === 'p1') throw new Error('unknown transport fault');
      return plannerDone();
    }));

    const result = await adapter.invokePlanner(plannerRequest('goal-1'));

    expect(result.status).toBe('done');
    expect(seen).toEqual(['p1', 'p2']);
    expect(adapter.candidateAvailability.isAvailable({ provider: 'p1', account: null, model: 'm1' })).toBe(false);
  });

  it('throws SessionInvariantError when executor reinvocation is missing card identity', async () => {
    const saivageDir = join(root, '.saivage');
    const session = createSession(saivageDir, 'executor', 'goal-1', null);
    const adapter = makeAdapter(root);

    await expect(adapter.reinvokeSession({ sessionId: session.id })).rejects.toThrow(SessionInvariantError);
    await expect(adapter.reinvokeSession({ sessionId: session.id })).rejects.toThrow(/missing card_id/);
  });

  it('throws SessionInvariantError when executor reinvocation is missing goal identity', async () => {
    const saivageDir = join(root, '.saivage');
    const session = createSession(saivageDir, 'executor', null, 'card-1');
    const adapter = makeAdapter(root);

    await expect(adapter.reinvokeSession({ sessionId: session.id })).rejects.toThrow(SessionInvariantError);
    await expect(adapter.reinvokeSession({ sessionId: session.id })).rejects.toThrow(/missing goal_card_id/);
  });

  it('throws SessionInvariantError when reviewer reinvocation is missing goal identity', async () => {
    const saivageDir = join(root, '.saivage');
    const session = createSession(saivageDir, 'reviewer', null, 'goal-1', undefined, 'reviewer:goal-1:assessment-1', 'assessment-1');
    const adapter = makeAdapter(root);

    await expect(adapter.reinvokeSession({ sessionId: session.id })).rejects.toThrow(SessionInvariantError);
    await expect(adapter.reinvokeSession({ sessionId: session.id })).rejects.toThrow(/missing goal_card_id/);
  });

  it('throws SessionInvariantError when reviewer reinvocation is missing assessment identity', async () => {
    const saivageDir = join(root, '.saivage');
    const session = createSession(saivageDir, 'reviewer', 'goal-1', 'goal-1');
    const adapter = makeAdapter(root);

    await expect(adapter.reinvokeSession({ sessionId: session.id })).rejects.toThrow(SessionInvariantError);
    await expect(adapter.reinvokeSession({ sessionId: session.id })).rejects.toThrow(/missing assessment_id/);
  });
});
