/**
 * Integration tests for agent modules — config → router → AgentAdapter envelope flow
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { loadConfig } from '../../src/agents/config-schema.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import type { LlmCallFn, LlmCompleteResult } from '../../src/agents/llm-contracts.js';
import { PlannerResultSchema, ExecutorResultSchema, ReviewerResultSchema } from '../../src/agents/role-envelope-schemas.js';
import { createSession, appendMessage, getSessionMessages, completeSession } from '../../src/agents/session-persistence.js';
import { invokeWithRecovery, type RecoveryContext } from '../../src/agents/recovery.js';

let TEST_ROOT: string;
let SAIVAGE_DIR: string;

function setup() {
  TEST_ROOT = mkdtempSync(join(tmpdir(), 'saivage-agent-integration-'));
  SAIVAGE_DIR = join(TEST_ROOT, '.saivage');
  mkdirSync(SAIVAGE_DIR, { recursive: true });
}

function cleanup() {
  if (TEST_ROOT && existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
}

function writeConfig(json: Record<string, unknown>) {
  writeFileSync(join(SAIVAGE_DIR, 'saivage.json'), JSON.stringify(json, null, 2), 'utf-8');
}

function baseAdapterConfig(roleModels: Partial<Record<'planner' | 'executor' | 'reviewer' | 'analyst', string[]>>): SaivageConfig {
  return ({
    models: { planner: ['m1'], executor: ['m1'], reviewer: ['m1'], analyst: ['m1'], ...roleModels },
    providers: {
      p1: { priority: 10, models: ['m1'], capabilities: { toolCalls: 'native', toolChoice: 'auto' } },
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

function makeAdapter(role: 'planner' | 'executor' | 'reviewer'): AgentAdapter {
  const cfg = baseAdapterConfig({ [role]: ['m1'] });
  return new AgentAdapter({ projectRoot: TEST_ROOT, saivageDir: SAIVAGE_DIR, config: cfg });
}

function terminalToolCall(toolName: string, payload: Record<string, unknown>): LlmCompleteResult {
  return {
    kind: 'tool_calls',
    tool_calls: [{
      id: `call-${toolName}`,
      type: 'function',
      function: { name: toolName, arguments: JSON.stringify(payload) },
    }],
  };
}

beforeEach(() => { cleanup(); setup(); });
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

describe('Integration: Config → Router → AgentAdapter envelope flow', () => {
  it('should load config and resolve role to candidates', async () => {
    writeConfig({
      models: {
        planner: ['gpt-5.5', 'kimi-k2.6'],
        executor: ['kimi-k2.6'],
        reviewer: ['gpt-5.5'],
        default: ['fallback'],
      },
      providers: {
        github: {
          priority: 10,
          models: ['gpt-5.5'],
          accounts: { primary: { priority: 10 }, secondary: { priority: 20 } },
        },
        opencode: { priority: 20, models: ['kimi-k2.6', 'deepseek-v4-pro'] },
      },
    });

    const { config } = loadConfig(TEST_ROOT);
    const registry = new ProviderRegistry(config);
    const router = new ModelRouter(config, registry);

    const plannerChain = await router.resolve('planner');
    expect(plannerChain.length).toBeGreaterThanOrEqual(3);
    expect(plannerChain[0].provider).toBe('github');
    expect(plannerChain[0].account).toBe('primary');
    expect(plannerChain[0].model).toBe('gpt-5.5');

    const executorChain = await router.resolve('executor');
    expect(executorChain).toHaveLength(1);
    expect(executorChain[0].model).toBe('kimi-k2.6');
  });

  it('drives invokePlanner against a terminal emit_planner_result tool call and validates the envelope', async () => {
    const adapter = makeAdapter('planner');
    const envelope = {
      status: 'continue' as const,
      created_cards: [{
        type: 'code', title: 'Implement auth module', description: 'Add authentication',
        status: 'backlog', depends_on: [], priority: 1,
      }],
      updated_cards: [],
      summary: 'queued auth work',
    };
    const llmCall = jest.fn<LlmCallFn>().mockResolvedValue(terminalToolCall('emit_planner_result', envelope));
    adapter.setLlmCallFn(llmCall);

    const result = await adapter.invokePlanner('goal-planner');

    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(() => PlannerResultSchema.parse(envelope)).not.toThrow();
    expect(result.status).toBe('continue');
    expect(result.created_cards).toHaveLength(1);
    expect(result.created_cards[0].title).toBe('Implement auth module');
    expect(result.summary).toBe('queued auth work');
  });

  it('drives invokeExecutor against a terminal emit_executor_result tool call and validates the envelope', async () => {
    const adapter = makeAdapter('executor');
    const envelope = {
      card_id: 'code-1',
      status: 'done' as const,
      status_text: 'Executor completed successfully',
      result: { lines_added: 42 },
      artifacts: [{ type: 'report' as const, description: 'Test results', retain: true }],
      attachments: [],
      summary: 'tests added',
    };
    const llmCall = jest.fn<LlmCallFn>().mockResolvedValue(terminalToolCall('emit_executor_result', envelope));
    adapter.setLlmCallFn(llmCall);

    const result = await adapter.invokeExecutor('code-1', 'goal-exec');

    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(() => ExecutorResultSchema.parse(envelope)).not.toThrow();
    expect(result.card_id).toBe('code-1');
    expect(result.status).toBe('done');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe('report');
    expect(result.fallback_with_evidence).toBeNull();
  });

  it('drives invokeReviewer against a terminal emit_reviewer_result tool call and validates the envelope', async () => {
    const adapter = makeAdapter('reviewer');
    const envelope = {
      assessment: {
        result: 'pass' as const,
        summary: 'All criteria satisfied',
        achieved: ['Auth module works'],
        issues: [],
        evidence_card_ids: ['code-1'],
      },
    };
    const llmCall = jest.fn<LlmCallFn>().mockResolvedValue(terminalToolCall('emit_reviewer_result', envelope));
    adapter.setLlmCallFn(llmCall);

    const result = await adapter.invokeReviewer('goal-review');

    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(() => ReviewerResultSchema.parse(envelope)).not.toThrow();
    expect(result.assessment.result).toBe('pass');
    expect(result.assessment.issues).toHaveLength(0);
    expect(result.assessment.evidence_card_ids).toEqual(['code-1']);
  });

  it('should handle recovery with session persistence', async () => {
    writeConfig({
      models: { executor: ['kimi-k2.6'] },
      providers: { opencode: { priority: 10, models: ['kimi-k2.6'] } },
      runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 2 },
    });

    const { config } = loadConfig(TEST_ROOT);
    const registry = new ProviderRegistry(config);
    const router = new ModelRouter(config, registry);

    const chain = await router.resolve('executor');
    expect(chain.length).toBeGreaterThan(0);

    const session = createSession(SAIVAGE_DIR, 'executor', 'goal-1', 'card-1');

    let callCount = 0;
    const executorFn = async (_ctx: RecoveryContext) => {
      callCount++;
      appendMessage(SAIVAGE_DIR, session.id, {
        role: 'user',
        kind: 'text',
        content: `Invocation ${callCount}`,
      }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
      if (callCount === 1) throw new Error('Model error');
      return { status: 'done', status_text: 'Recovered successfully', error: undefined, artifacts: [], attachments: [] };
    };

    const attempts = await invokeWithRecovery(executorFn, {
      recoveryDelayMs: 10,
      maxRetries: 2,
      sessionId: session.id,
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[1].success).toBe(true);

    completeSession(SAIVAGE_DIR, session.id, 'done');

    const persistedMessages = getSessionMessages(SAIVAGE_DIR, session.id);
    expect(persistedMessages.length).toBeGreaterThan(0);
  });

  it('should handle provider cooldown in integration flow', async () => {
    writeConfig({
      models: { planner: ['gpt-5.5'] },
      providers: {
        github: { priority: 10, models: ['gpt-5.5'] },
        opencode: { priority: 20, models: ['gpt-5.5'] },
      },
    });

    const { config } = loadConfig(TEST_ROOT);
    const registry = new ProviderRegistry(config);
    const availability = new (await import('../../src/agents/candidate-availability.js')).MemoryCandidateAvailability();

    await availability.markFailed(
      { provider: 'github', account: null, model: 'gpt-5.5' },
      { state: 'COOLING', untilMs: Date.now() + 60000, reason: 'test' },
    );

    const router = new ModelRouter(config, registry, undefined, availability);
    const chain = await router.resolve('planner');

    expect(chain).toHaveLength(1);
    expect(chain[0].provider).toBe('opencode');
  });
});
