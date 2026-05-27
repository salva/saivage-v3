/**
 * Integration tests for agent modules — config → router → parsing flow
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

const TEST_ROOT = join(tmpdir(), `saivage-agent-integration-${Date.now()}`);
const SAIVAGE_DIR = join(TEST_ROOT, '.saivage');

let loadConfig: typeof import('../../src/agents/config-schema.js').loadConfig;
let getModelListForRole: typeof import('../../src/agents/config-schema.js').getModelListForRole;
let ProviderRegistry: typeof import('../../src/agents/provider.js').ProviderRegistry;
let ModelRouter: typeof import('../../src/agents/model-router.js').ModelRouter;
let parsePlannerResult: typeof import('../../src/agents/result-parser.js').parsePlannerResult;
let parseExecutorResult: typeof import('../../src/agents/result-parser.js').parseExecutorResult;
let parseReviewerResult: typeof import('../../src/agents/result-parser.js').parseReviewerResult;
let createSession: typeof import('../../src/agents/session-persistence.js').createSession;
let appendMessage: typeof import('../../src/agents/session-persistence.js').appendMessage;
let getSessionMessages: typeof import('../../src/agents/session-persistence.js').getSessionMessages;
let completeSession: typeof import('../../src/agents/session-persistence.js').completeSession;
let invokeWithRecovery: typeof import('../../src/agents/recovery.js').invokeWithRecovery;

beforeAll(async () => {
  const configMod = await import('../../src/agents/config-schema.js');
  loadConfig = configMod.loadConfig;
  getModelListForRole = configMod.getModelListForRole;

  const providerMod = await import('../../src/agents/provider.js');
  ProviderRegistry = providerMod.ProviderRegistry;

  const routerMod = await import('../../src/agents/model-router.js');
  ModelRouter = routerMod.ModelRouter;

  const parserMod = await import('../../src/agents/result-parser.js');
  parsePlannerResult = parserMod.parsePlannerResult;
  parseExecutorResult = parserMod.parseExecutorResult;
  parseReviewerResult = parserMod.parseReviewerResult;

  const sessionMod = await import('../../src/agents/session-persistence.js');
  createSession = sessionMod.createSession;
  appendMessage = sessionMod.appendMessage;
  getSessionMessages = sessionMod.getSessionMessages;
  completeSession = sessionMod.completeSession;

  const recoveryMod = await import('../../src/agents/recovery.js');
  invokeWithRecovery = recoveryMod.invokeWithRecovery;
});

function setup() {
  mkdirSync(SAIVAGE_DIR, { recursive: true });
}

function cleanup() {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

function writeConfig(json: Record<string, unknown>) {
  writeFileSync(
    join(SAIVAGE_DIR, 'saivage.json'),
    JSON.stringify(json, null, 2),
    'utf-8',
  );
}

beforeEach(() => {
  cleanup();
  setup();
});
afterEach(() => cleanup());

describe('Integration: Config → Router → Parsing', () => {
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
          accounts: {
            primary: { priority: 10 },
            secondary: { priority: 20 },
          },
        },
        opencode: {
          priority: 20,
          models: ['kimi-k2.6', 'deepseek-v4-pro'],
        },
      },
    });

    const { config } = loadConfig(TEST_ROOT);
    const registry = new ProviderRegistry(config);
    const router = new ModelRouter(config, registry);

    // Planner should get github/primary/gpt-5.5 first
    const plannerChain = await router.resolve('planner');
    expect(plannerChain.length).toBeGreaterThanOrEqual(3);
    expect(plannerChain[0].provider).toBe('github');
    expect(plannerChain[0].account).toBe('primary');
    expect(plannerChain[0].model).toBe('gpt-5.5');

    // Executor should get opencode/kimi-k2.6
    const executorChain = await router.resolve('executor');
    expect(executorChain).toHaveLength(1);
    expect(executorChain[0].model).toBe('kimi-k2.6');
  });

  it('should flow from config → router → parse planner result', async () => {
    writeConfig({
      models: { planner: ['gpt-5.5'] },
      providers: {
        github: { priority: 10, models: ['gpt-5.5'] },
      },
    });

    const { config } = loadConfig(TEST_ROOT);
    const registry = new ProviderRegistry(config);
    const router = new ModelRouter(config, registry);

    // Resolve candidates for planner
    const chain = await router.resolve('planner');
    expect(chain.length).toBeGreaterThan(0);

    // Simulate parsing a planner response
    const rawResponse = JSON.stringify({
      created_cards: [
        {
          type: 'code',
          title: 'Implement auth module',
          description: 'Add authentication',
          status: 'backlog',
          depends_on: [],
          priority: 1,
        },
      ],
      updated_cards: [],
      status: 'continue',
    });

    const parsed = parsePlannerResult(rawResponse);
    expect(parsed.created_cards).toHaveLength(1);
    expect(parsed.created_cards[0].title).toBe('Implement auth module');
    expect(parsed.status).toBe('continue');
  });

  it('should flow from config → router → parse executor result', async () => {
    writeConfig({
      models: { executor: ['kimi-k2.6'] },
      providers: {
        opencode: { priority: 10, models: ['kimi-k2.6'] },
      },
    });

    const { config } = loadConfig(TEST_ROOT);
    const registry = new ProviderRegistry(config);
    const router = new ModelRouter(config, registry);

    const chain = await router.resolve('executor');
    expect(chain.length).toBeGreaterThan(0);

    const rawResponse = JSON.stringify({
      card_id: 'code-1',
      status: 'done',
      status_text: 'Executor completed successfully',
      result: { lines_added: 42 },
      artifacts: [
        { type: 'report', description: 'Test results', retain: true },
      ],
      attachments: [],
    });

    const parsed = parseExecutorResult(rawResponse);
    expect(parsed.status).toBe('done');
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0].type).toBe('report');
  });

  it('should flow from config → router → parse reviewer result', async () => {
    writeConfig({
      models: { reviewer: ['gpt-5.5'] },
      providers: {
        github: { priority: 10, models: ['gpt-5.5'] },
      },
    });

    const { config } = loadConfig(TEST_ROOT);
    const registry = new ProviderRegistry(config);
    const router = new ModelRouter(config, registry);

    const chain = await router.resolve('reviewer');
    expect(chain.length).toBeGreaterThan(0);

    const rawResponse = JSON.stringify({
      assessment: {
        result: 'pass',
        summary: 'All criteria satisfied',
        achieved: ['Auth module works'],
        issues: [],
        evidence_card_ids: ['code-1'],
      },
    });

    const parsed = parseReviewerResult(rawResponse);
    expect(parsed.assessment.result).toBe('pass');
    expect(parsed.assessment.issues).toHaveLength(0);
  });

  it('should handle recovery with session persistence', async () => {
    writeConfig({
      models: { executor: ['kimi-k2.6'] },
      providers: {
        opencode: { priority: 10, models: ['kimi-k2.6'] },
      },
      runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 2 },
    });

    const { config } = loadConfig(TEST_ROOT);
    const registry = new ProviderRegistry(config);
    const router = new ModelRouter(config, registry);

    const chain = await router.resolve('executor');
    expect(chain.length).toBeGreaterThan(0);

    const session = createSession(SAIVAGE_DIR, 'executor', 'goal-1', 'card-1');

    // Simulate executor function that fails then succeeds
    let callCount = 0;
    const executorFn = async (_ctx: import('../../src/agents/recovery.js').RecoveryContext) => {
      callCount++;
      appendMessage(SAIVAGE_DIR, session.id, {
        role: 'user',
        kind: 'text',
        content: `Invocation ${callCount}`,
      }, { round_id: 'r-user-1', message_index: 0, block_index: 0 });
      if (callCount === 1) {
        throw new Error('Model error');
      }
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

    // Mark github candidate as failed
    registry.markFailed(
      { provider: 'github', account: null, model: 'gpt-5.5' },
      60000,
    );

    const router = new ModelRouter(config, registry);
    const chain = await router.resolve('planner');

    // Should skip github (cooldown) and use opencode
    expect(chain).toHaveLength(1);
    expect(chain[0].provider).toBe('opencode');
  });
});
