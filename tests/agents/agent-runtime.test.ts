import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { FakeAgentAdapter, type FakeAgentFixture } from '../../src/utils/fake-agent.js';
import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import type { AgentRuntime } from '../../src/agents/agent-runtime.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import type { PlannerResult } from '../../src/agents/result-parser.js';

// ── Helpers ───────────────────────────────────────────────────

/**
 * Type-level check: accept any object that implements AgentRuntime.
 * This function is used as a compile-time assertion that a class conforms
 * to the interface.
 */
function assertAgentRuntime(rt: AgentRuntime): AgentRuntime {
  return rt;
}

function makeFixtureDir(tmpDir: string): string {
  const dir = join(tmpDir, 'fixtures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(dir: string, name: string, fixture: FakeAgentFixture): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2), 'utf-8');
}

/**
 * Write a minimal saivage.json so the AgentAdapter can be constructed.
 */
function writeMinimalConfig(tmpDir: string): void {
  const config: SaivageConfig = {
    models: {},
    providers: {},
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      recoverAgentInvocations: true,
      healthCheckIntervalMs: 30000,
      idleShutdownMs: 300000,
      maxGoalDepth: 5,
      recoveryDelayMs: 60000,
      continuousImprovement: false,
      compactionThreshold: 0.8,
      maxCompactions: 3,
      compactionTimeoutMs: 1200000,
      compactionKeepFraction: 0.2,
      maxRecoveryRetries: 3,
      selfCheck: { executor: 15, planner: 30, analyst: 0 },
    },
    security: {
      injectionScanner: true,
      maxScanLengthBytes: 102400,
    },
    supervisor: {
      enabled: true,
      intervalMs: 1200000,
      consecutiveStuckVerdicts: 3,
      logLines: 400,
    },
  };
  writeFileSync(
    join(tmpDir, '.saivage', 'saivage.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
}

/**
 * Read a minimal config from the written file and create an AgentAdapter.
 */
function createMinimalAdapter(tmpDir: string): AgentAdapter {
  writeMinimalConfig(tmpDir);
  const configRaw = readFileSync(join(tmpDir, '.saivage', 'saivage.json'), 'utf-8');
  const config = JSON.parse(configRaw) as SaivageConfig;
  return new AgentAdapter({
    projectRoot: tmpDir,
    saivageDir: join(tmpDir, '.saivage'),
    config,
  });
}

// ── Test Suite ────────────────────────────────────────────────

describe('AgentRuntime Interface', () => {
  let tmpDir: string;
  let fixtureDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-art-'));
    fixtureDir = makeFixtureDir(tmpDir);
    initProjectTree(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════════
  // FakeAgentAdapter conforms to AgentRuntime
  // ═══════════════════════════════════════════════════════════════

  describe('FakeAgentAdapter implements AgentRuntime', () => {
    it('satisfies AgentRuntime interface at the type level', () => {
      const fixture: FakeAgentFixture = {
        name: 'test-goal',
        planner: [
          {
            plan_card_id: 'plan-goal-1',
            created_cards: [],
            declare_done: false,
          },
        ],
        executor: {},
        reviewer: [],
      };
      writeFixture(fixtureDir, 'test-goal', fixture);

      const adapter = new FakeAgentAdapter({
        mapping: { 'goal-1': 'test-goal', '*': 'test-goal' },
        fixtureDir,
      });

      // Type-level check — this compiles ONLY if FakeAgentAdapter implements AgentRuntime
      const rt: AgentRuntime = assertAgentRuntime(adapter);
      expect(rt).toBe(adapter);
    });

    it('invokePlanner returns PlannerResult (AgentRuntime signature)', () => {
      const fixture: FakeAgentFixture = {
        name: 'test-goal',
        planner: [
          {
            plan_card_id: 'plan-goal-1',
            created_cards: [
              {
                id: 'code-test-1',
                type: 'code',
                title: 'Test card',
                description: 'A test card',
                status: 'backlog',
                depends_on: [],
                priority: 1,
              },
            ],
            updated_cards: [],
            declare_done: false,
          },
        ],
        executor: {},
        reviewer: [],
      };
      writeFixture(fixtureDir, 'test-goal', fixture);

      const adapter = new FakeAgentAdapter({
        mapping: { 'goal-1': 'test-goal', '*': 'test-goal' },
        fixtureDir,
      });

      // Call via AgentRuntime signature (with optional params)
      const result = adapter.invokePlanner('goal-1', 'plan-goal-1', 'system prompt', []);

      // Verify return type matches PlannerResult
      const pr: PlannerResult = result;
      expect(pr.plan_card_id).toBe('plan-goal-1');
      expect(pr.created_cards).toHaveLength(1);
      expect(pr.created_cards[0].id).toBe('code-test-1');
      expect(pr.created_cards[0].type).toBe('code');
      expect(pr.created_cards[0].title).toBe('Test card');
      expect(pr.declare_done).toBe(false);
    });

    it('invokeExecutor returns ExecutorResult (AgentRuntime signature)', () => {
      const fixture: FakeAgentFixture = {
        name: 'test-goal',
        planner: [],
        executor: {
          'code-test-1': {
            card_id: 'code-test-1',
            status: 'done',
            artifacts: [
              {
                sourceFile: 'src/test.ts',
                type: 'data',
                description: 'Test source file',
                retain: true,
              },
            ],
          },
        },
        reviewer: [],
      };
      writeFixture(fixtureDir, 'test-goal', fixture);

      const adapter = new FakeAgentAdapter({
        mapping: { 'goal-1': 'test-goal', '*': 'test-goal' },
        fixtureDir,
      });

      // Call via AgentRuntime signature
      const result = adapter.invokeExecutor('code-test-1', 'goal-1', 'system prompt', []);

      expect(result.card_id).toBe('code-test-1');
      expect(result.status).toBe('done');
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].type).toBe('data');
      expect(result.artifacts[0].description).toBe('Test source file');
      expect(result.artifacts[0].retain).toBe(true);
    });

    it('invokeReviewer returns ReviewerResult (AgentRuntime signature)', () => {
      const fixture: FakeAgentFixture = {
        name: 'test-goal',
        planner: [],
        executor: {},
        reviewer: [
          {
            assessment: {
              id: 'review-test-1',
              goal_card_id: 'goal-1',
              plan_card_id: 'plan-goal-1',
              reviewer_session_id: 'rev-session',
              result: 'pass',
              summary: 'All good.',
              achieved: ['All criteria met'],
              missing: [],
              evidence_card_ids: ['code-test-1'],
              created_at: new Date().toISOString(),
            },
          },
        ],
      };
      writeFixture(fixtureDir, 'test-goal', fixture);

      const adapter = new FakeAgentAdapter({
        mapping: { 'goal-1': 'test-goal', '*': 'test-goal' },
        fixtureDir,
      });

      // Call via AgentRuntime signature
      const result = adapter.invokeReviewer('goal-1', 'plan-goal-1', 'system prompt', []);

      expect(result.assessment.result).toBe('pass');
      expect(result.assessment.summary).toBe('All good.');
      expect(result.assessment.achieved).toEqual(['All criteria met']);
      expect(result.assessment.missing).toEqual([]);
      expect(result.assessment.evidence_card_ids).toEqual(['code-test-1']);
    });

    it('backward-compatible overloads still work (single-arg invokePlanner)', () => {
      // Need TWO planner results since the test calls invokePlanner twice
      const fixture: FakeAgentFixture = {
        name: 'test-goal',
        planner: [
          {
            plan_card_id: 'plan-goal-1',
            created_cards: [],
            declare_done: true,
          },
          {
            plan_card_id: 'plan-goal-1',
            created_cards: [],
            declare_done: false,
          },
        ],
        executor: {},
        reviewer: [],
      };
      writeFixture(fixtureDir, 'test-goal', fixture);

      const adapter = new FakeAgentAdapter({
        mapping: { 'goal-1': 'test-goal', '*': 'test-goal' },
        fixtureDir,
      });

      // Backward compat: single argument call returns FakePlannerResult
      const rawResult = adapter.invokePlanner('goal-1');
      expect(rawResult.plan_card_id).toBe('plan-goal-1');
      expect(rawResult.declare_done).toBe(true);

      // Can also call with all 4 params (second invocation, second fixture entry)
      const interfaceResult = adapter.invokePlanner('goal-1', 'plan-goal-1', 'prompt', []);
      expect(interfaceResult.plan_card_id).toBe('plan-goal-1');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // AgentAdapter conforms to AgentRuntime (type-level)
  // ═══════════════════════════════════════════════════════════════

  describe('AgentAdapter implements AgentRuntime', () => {
    it('satisfies AgentRuntime interface at the type level', () => {
      const adapter = createMinimalAdapter(tmpDir);
      const rt: AgentRuntime = assertAgentRuntime(adapter);
      expect(rt).toBe(adapter);
    });

    it('AgentAdapter has invokePlanner method matching the interface', () => {
      const adapter = createMinimalAdapter(tmpDir);
      expect(typeof adapter.invokePlanner).toBe('function');
    });

    it('AgentAdapter has invokeExecutor method matching the interface', () => {
      const adapter = createMinimalAdapter(tmpDir);
      expect(typeof adapter.invokeExecutor).toBe('function');
    });

    it('AgentAdapter has invokeReviewer method matching the interface', () => {
      const adapter = createMinimalAdapter(tmpDir);
      expect(typeof adapter.invokeReviewer).toBe('function');
    });
  });
});
