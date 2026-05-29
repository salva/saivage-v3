/**
 * Self-Check Mechanism Tests
 *
 * Tests the self-check round tracking, threshold triggers, config overrides,
 * role-change reset, analyst never triggers, and event logging.
 *
 * Tests focus on:
 *  1. getSelfCheckThreshold returns correct defaults and overrides
 *  2. buildSelfCheckPrompt produces correct prompts
 *  3. Config schema properly validates selfCheck settings
 *  4. AgentAdapter round tracking and self-check injection
 *  5. Role change resets round counters
 *  6. Event logging when self-check triggers
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { EventLogger } from '../../src/observability/event-logger.js';
import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import {
  getSelfCheckThreshold,
  getRuntimeConfig,
  loadConfig,
  saivageConfigSchema,
} from '../../src/agents/config-schema.js';
import { buildSelfCheckPrompt, systemPromptBuilder } from '../../src/agents/system-prompt.js';
import type { SaivageConfig, SelfCheckConfig } from '../../src/agents/config-schema.js';
import type { LoggedEvent, SelfCheckTriggeredEvent } from '../../src/schemas/types.js';

// ── Helpers ───────────────────────────────────────────────────

function makeMinimalConfig(overrides?: Partial<SaivageConfig>): SaivageConfig {
  return {
    models: {},
    providers: {},
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      candidateAvailabilityCompactBytes: 262144,
      recoverAgentInvocations: true,
      healthCheckIntervalMs: 30000,
      idleShutdownMs: 300000,
      maxGoalDepth: 5,
      recoveryDelayMs: 60000,
      autoDispatchBacklog: true,
      continuousImprovement: false, maxReviewRetries: 3, processTimeouts: { plannerMs: 1200000, executorMs: 1200000, reviewerMs: 1200000 },
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
    ...overrides,
  };
}

function setupTempProject(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'saivage-sc-'));
  initProjectTree(tmpDir);
  mkdirSync(join(tmpDir, '.saivage', 'sessions'), { recursive: true });
  return tmpDir;
}

function writeConfig(tmpDir: string, config: SaivageConfig): void {
  writeFileSync(
    join(tmpDir, '.saivage', 'saivage.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
}

/**
 * Create a minimal AgentAdapter suitable for unit-testing self-check logic.
 * Since invokeAgent is private and requires an LLM call function, we test the
 * self-check mechanism through a thin proxy that exposes the private methods.
 *
 * We access private members via array-style indexing on the instance —
 * this is a standard pattern for testing private methods in TypeScript.
 */
function createAdapterForSelfCheck(
  tmpDir: string,
  overrides?: Partial<SaivageConfig>,
  eventLogger?: EventLogger,
  eventBus?: EventEmitter,
): {
  adapter: AgentAdapter;
  applySelfCheck: (role: string, systemPrompt: string, sessionId: string) => string;
  getRoundCounter: (role: string) => number;
  getLastRole: () => string | null;
  resetOnRoleChange: (role: string) => void;
} {
  const config = makeMinimalConfig(overrides);
  writeConfig(tmpDir, config);

  const adapter = new AgentAdapter({
    projectRoot: tmpDir,
    saivageDir: join(tmpDir, '.saivage'),
    config,
    eventBus,
    eventLogger,
  });

  return {
    adapter,
    // Expose private method via bracket access
    applySelfCheck: (role, systemPrompt, sessionId) =>
      (adapter as unknown as Record<string, Function>)['applySelfCheck'](role, systemPrompt, sessionId),
    getRoundCounter: (role: string) => {
      const runner = (adapter as unknown as { roleRunner: { roundCounters: Map<string, number> } }).roleRunner;
      return runner.roundCounters.get(role) ?? 0;
    },
    getLastRole: () => {
      const runner = (adapter as unknown as { roleRunner: { lastRole: string | null } }).roleRunner;
      return runner.lastRole;
    },
    resetOnRoleChange: (role: string) => {
      (adapter as unknown as Record<string, Function>)['resetOnRoleChange'](role);
    },
  };
}

// ── Test Suite: getSelfCheckThreshold ─────────────────────────

describe('getSelfCheckThreshold', () => {
  it('returns 15 for executor by default', () => {
    const config = makeMinimalConfig();
    expect(getSelfCheckThreshold(config, 'executor')).toBe(15);
  });

  it('returns 30 for planner by default', () => {
    const config = makeMinimalConfig();
    expect(getSelfCheckThreshold(config, 'planner')).toBe(30);
  });

  it('returns 0 for analyst by default (never triggers)', () => {
    const config = makeMinimalConfig();
    expect(getSelfCheckThreshold(config, 'analyst')).toBe(0);
  });

  it('returns 0 for unknown roles', () => {
    const config = makeMinimalConfig();
    expect(getSelfCheckThreshold(config, 'reviewer')).toBe(0);
    expect(getSelfCheckThreshold(config, 'manager')).toBe(0);
    expect(getSelfCheckThreshold(config, 'coder')).toBe(0);
    expect(getSelfCheckThreshold(config, 'researcher')).toBe(0);
    expect(getSelfCheckThreshold(config, 'data_agent')).toBe(0);
    expect(getSelfCheckThreshold(config, 'inspector')).toBe(0);
    expect(getSelfCheckThreshold(config, 'chat')).toBe(0);
  });

  it('respects config overrides: executor=5, planner=10', () => {
    const config = makeMinimalConfig({
      runtime: {
        ...makeMinimalConfig().runtime,
        selfCheck: { executor: 5, planner: 10, analyst: 0 },
      },
    });
    expect(getSelfCheckThreshold(config, 'executor')).toBe(5);
    expect(getSelfCheckThreshold(config, 'planner')).toBe(10);
    expect(getSelfCheckThreshold(config, 'analyst')).toBe(0);
  });

  it('returns 0 when selfCheck section is missing', () => {
    const config = makeMinimalConfig();
    // Remove selfCheck
    const runtimeNoSC = { ...config.runtime };
    delete (runtimeNoSC as Record<string, unknown>).selfCheck;
    const configNoSC = { ...config, runtime: runtimeNoSC };
    expect(getSelfCheckThreshold(configNoSC, 'executor')).toBe(0);
    expect(getSelfCheckThreshold(configNoSC, 'planner')).toBe(0);
  });

  it('returns 0 when selfCheck section is an empty object', () => {
    const config = makeMinimalConfig({
      runtime: {
        ...makeMinimalConfig().runtime,
        selfCheck: {} as unknown as SelfCheckConfig,
      },
    });
    // Empty object means no keys = all 0
    expect(getSelfCheckThreshold(config, 'executor')).toBe(0);
    expect(getSelfCheckThreshold(config, 'planner')).toBe(0);
    expect(getSelfCheckThreshold(config, 'analyst')).toBe(0);
  });

  it('threshold 0 means never triggers regardless of count', () => {
    const config = makeMinimalConfig({
      runtime: {
        ...makeMinimalConfig().runtime,
        selfCheck: { executor: 0, planner: 0, analyst: 0 },
      },
    });
    expect(getSelfCheckThreshold(config, 'executor')).toBe(0);
    expect(getSelfCheckThreshold(config, 'planner')).toBe(0);
  });
});

// ── Test Suite: buildSelfCheckPrompt ──────────────────────────

describe('buildSelfCheckPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildSelfCheckPrompt('executor', 15, 15);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('contains "Self-Check Assessment" header', () => {
    const prompt = buildSelfCheckPrompt('executor', 15, 15);
    expect(prompt).toContain('Self-Check Assessment');
  });

  it('contains the round count and threshold', () => {
    const prompt = buildSelfCheckPrompt('executor', 15, 15);
    expect(prompt).toContain('15');
  });

  it('contains "Progress" evaluation category', () => {
    const prompt = buildSelfCheckPrompt('executor', 5, 10);
    expect(prompt).toContain('Progress');
  });

  it('contains "Circular behavior" evaluation category', () => {
    const prompt = buildSelfCheckPrompt('executor', 5, 10);
    expect(prompt).toContain('Circular behavior');
  });

  it('contains "Redundancy" evaluation category', () => {
    const prompt = buildSelfCheckPrompt('executor', 5, 10);
    expect(prompt).toContain('Redundancy');
  });

  it('contains "Goal drift" evaluation category', () => {
    const prompt = buildSelfCheckPrompt('executor', 5, 10);
    expect(prompt).toContain('Goal drift');
  });

  it('mentions the self_check JSON response format', () => {
    const prompt = buildSelfCheckPrompt('executor', 15, 15);
    expect(prompt).toContain('self_check');
    expect(prompt).toContain('"ok"');
    expect(prompt).toContain('"stuck"');
    expect(prompt).toContain('"escalate"');
  });

  it('works for planner role', () => {
    const prompt = buildSelfCheckPrompt('planner', 30, 30);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('tool-call rounds');
  });

  it('works for analyst role', () => {
    const prompt = buildSelfCheckPrompt('analyst', 0, 0);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('is accessible via systemPromptBuilder namespace', () => {
    const prompt = systemPromptBuilder.buildSelfCheckPrompt('planner', 30, 30);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('Self-Check');
  });

  it('includes specific round and threshold values in the prompt text', () => {
    const prompt = buildSelfCheckPrompt('planner', 7, 30);
    expect(prompt).toContain('7');
    expect(prompt).toContain('30');
  });
});

// ── Test Suite: Config Schema Self-Check Defaults ─────────────

describe('Config Schema — Self-Check', () => {
  it('applies default selfCheck values', () => {
    const result = saivageConfigSchema.parse({
      models: { default: ['test'] },
    });
    expect(result.runtime.selfCheck).toEqual({
      executor: 15,
      planner: 30,
      analyst: 0,
    });
  });

  it('rejects persisted selfCheck overrides because §13 runtime config is authoritative', () => {
    expect(() => saivageConfigSchema.parse({
      models: { default: ['test'] },
      runtime: {
        selfCheck: { executor: 5, planner: 10, analyst: 0 },
      },
    })).toThrow(/Unrecognized key/);
  });

  it('rejects partial persisted selfCheck overrides', () => {
    expect(() => saivageConfigSchema.parse({
      models: { default: ['test'] },
      runtime: {
        selfCheck: { executor: 5 },
      },
    })).toThrow(/Unrecognized key/);
  });

  it('rejects legacy selfCheck section with negative values as non-authoritative', () => {
    const result = saivageConfigSchema.safeParse({
      models: { default: ['test'] },
      runtime: {
        selfCheck: { executor: -1, planner: 30, analyst: 0 },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects legacy selfCheck section with non-integer values as non-authoritative', () => {
    const result = saivageConfigSchema.safeParse({
      models: { default: ['test'] },
      runtime: {
        selfCheck: { executor: 5.5, planner: 30, analyst: 0 },
      },
    });
    expect(result.success).toBe(false);
  });

  it('defaults selfCheck to {} when missing, which runtime interprets as all-0', () => {
    // When the selfCheck key is missing from input, the schema should default it to {}
    // However, the schema uses selfCheckSchema.default({}), so it defaults to the
    // full defaults: { executor: 15, planner: 30, analyst: 0 }
    const result = saivageConfigSchema.parse({
      models: { default: ['test'] },
      runtime: {},
    });
    // schema default({}) applies only when the selfCheck field is absent —
    // but since selfCheckSchema.default({}) is the whole object default,
    // when runtime.selfCheck is missing, Zod applies the selfCheckSchema default
    // which is {}, and then each field defaults within that schema
    // Actually, selfCheckSchema.default({}) means: if selfCheck is undefined, use {}
    // Then each field: executor: z.number().int().nonnegative().default(15)
    // So the result should be { executor: 15, planner: 30, analyst: 0 }
    expect(result.runtime.selfCheck).toBeDefined();
    if (result.runtime.selfCheck) {
      expect(result.runtime.selfCheck.executor).toBe(15);
      expect(result.runtime.selfCheck.planner).toBe(30);
      expect(result.runtime.selfCheck.analyst).toBe(0);
    }
  });
});

// ── Test Suite: AgentAdapter Self-Check Integration ───────────

describe('AgentAdapter self-check integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTempProject();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════════
  // Round counter increments
  // ═══════════════════════════════════════════════════════════════

  describe('round counter increments', () => {
    it('increments round counter on each applySelfCheck call', () => {
      const { applySelfCheck, getRoundCounter } = createAdapterForSelfCheck(tmpDir);

      expect(getRoundCounter('executor')).toBe(0);

      applySelfCheck('executor', 'base prompt', 'sess-1');
      expect(getRoundCounter('executor')).toBe(1);

      applySelfCheck('executor', 'base prompt', 'sess-1');
      expect(getRoundCounter('executor')).toBe(2);

      applySelfCheck('executor', 'base prompt', 'sess-1');
      expect(getRoundCounter('executor')).toBe(3);
    });

    it('tracks counters independently per role', () => {
      const { applySelfCheck, getRoundCounter } = createAdapterForSelfCheck(tmpDir);

      applySelfCheck('executor', 'base', 'sess-1');
      applySelfCheck('executor', 'base', 'sess-1');
      applySelfCheck('planner', 'base', 'sess-2');

      expect(getRoundCounter('executor')).toBe(2);
      expect(getRoundCounter('planner')).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Threshold triggers
  // ═══════════════════════════════════════════════════════════════

  describe('threshold triggers', () => {
    it('does NOT append self-check prompt before threshold is met (round 14 of 15)', () => {
      const { applySelfCheck } = createAdapterForSelfCheck(tmpDir);
      const basePrompt = 'You are an executor.';

      // First 14 calls — no self-check should be appended
      for (let i = 1; i <= 14; i++) {
        const result = applySelfCheck('executor', basePrompt, 'sess-1');
        // Should not contain self-check prompt
        expect(result).not.toContain('Self-Check Assessment');
        // Should be same as base since nothing is appended
        expect(result).toBe(basePrompt);
      }
    });

    it('appends self-check prompt at the 15th invocation for executor (default threshold)', () => {
      const { applySelfCheck } = createAdapterForSelfCheck(tmpDir);
      const basePrompt = 'You are an executor.';

      // 14 calls without self-check
      for (let i = 1; i <= 14; i++) {
        applySelfCheck('executor', basePrompt, 'sess-1');
      }

      // 15th call — should append self-check
      const result = applySelfCheck('executor', basePrompt, 'sess-1');
      expect(result).toContain('Self-Check Assessment');
      expect(result.startsWith(basePrompt)).toBe(true);
      expect(result.length).toBeGreaterThan(basePrompt.length);
    });

    it('appends self-check prompt at 30th invocation for planner (default threshold)', () => {
      const { applySelfCheck } = createAdapterForSelfCheck(tmpDir);
      const basePrompt = 'You are a planner.';

      // 29 calls without self-check
      for (let i = 1; i <= 29; i++) {
        const result = applySelfCheck('planner', basePrompt, 'sess-p');
        expect(result).not.toContain('Self-Check Assessment');
      }

      // 30th call — should append
      const result = applySelfCheck('planner', basePrompt, 'sess-p');
      expect(result).toContain('Self-Check Assessment');
    });

    it('triggers at every threshold multiple (15, 30, 45...)', () => {
      const { applySelfCheck } = createAdapterForSelfCheck(tmpDir);
      const basePrompt = 'You are an executor.';

      // Round 15: triggers
      for (let i = 1; i <= 14; i++) applySelfCheck('executor', basePrompt, 'sess-1');
      expect(applySelfCheck('executor', basePrompt, 'sess-1')).toContain('Self-Check Assessment');

      // Round 16-29: no trigger
      for (let i = 16; i <= 29; i++) {
        expect(applySelfCheck('executor', basePrompt, 'sess-1')).not.toContain('Self-Check Assessment');
      }

      // Round 30: triggers again
      expect(applySelfCheck('executor', basePrompt, 'sess-1')).toContain('Self-Check Assessment');
    });

    it('does not append at partial multiples (e.g., round 20 with threshold 15)', () => {
      const { applySelfCheck } = createAdapterForSelfCheck(tmpDir);
      const basePrompt = 'You are an executor.';

      // Trigger at 15
      for (let i = 1; i <= 14; i++) applySelfCheck('executor', basePrompt, 'sess-1');
      applySelfCheck('executor', basePrompt, 'sess-1'); // triggers

      // Round 20 (should NOT trigger — 20 % 15 !== 0)
      for (let i = 16; i <= 20; i++) {
        const result = applySelfCheck('executor', basePrompt, 'sess-1');
        if (i === 20) {
          expect(result).not.toContain('Self-Check Assessment');
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Config overrides for threshold frequencies
  // ═══════════════════════════════════════════════════════════════

  describe('config overrides', () => {
    it('executor triggers at round 5 when threshold is overridden to 5', () => {
      const { applySelfCheck } = createAdapterForSelfCheck(tmpDir, {
        runtime: {
          ...makeMinimalConfig().runtime,
          selfCheck: { executor: 5, planner: 30, analyst: 0 },
        },
      });
      const basePrompt = 'You are an executor.';

      // Rounds 1-4: no trigger
      for (let i = 1; i <= 4; i++) {
        expect(applySelfCheck('executor', basePrompt, 'sess-1')).not.toContain('Self-Check Assessment');
      }

      // Round 5: triggers
      expect(applySelfCheck('executor', basePrompt, 'sess-1')).toContain('Self-Check Assessment');
    });

    it('planner triggers at round 10 when threshold is overridden to 10', () => {
      const { applySelfCheck } = createAdapterForSelfCheck(tmpDir, {
        runtime: {
          ...makeMinimalConfig().runtime,
          selfCheck: { executor: 15, planner: 10, analyst: 0 },
        },
      });
      const basePrompt = 'You are a planner.';

      // Rounds 1-9: no trigger
      for (let i = 1; i <= 9; i++) {
        expect(applySelfCheck('planner', basePrompt, 'sess-p')).not.toContain('Self-Check Assessment');
      }

      // Round 10: triggers
      expect(applySelfCheck('planner', basePrompt, 'sess-p')).toContain('Self-Check Assessment');
    });

    it('both thresholds can be overridden simultaneously', () => {
      const { applySelfCheck } = createAdapterForSelfCheck(tmpDir, {
        runtime: {
          ...makeMinimalConfig().runtime,
          selfCheck: { executor: 3, planner: 7, analyst: 0 },
        },
      });
      const basePrompt = 'Base prompt.';

      // Executor: trigger at 3
      for (let i = 1; i <= 2; i++) applySelfCheck('executor', basePrompt, 'sess-e');
      expect(applySelfCheck('executor', basePrompt, 'sess-e')).toContain('Self-Check Assessment');

      // Planner: trigger at 7
      for (let i = 1; i <= 6; i++) applySelfCheck('planner', basePrompt, 'sess-p');
      expect(applySelfCheck('planner', basePrompt, 'sess-p')).toContain('Self-Check Assessment');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Analyst never triggers (threshold 0)
  // ═══════════════════════════════════════════════════════════════

  describe('analyst never triggers', () => {
    it('never appends self-check for analyst regardless of invocation count', () => {
      const { applySelfCheck } = createAdapterForSelfCheck(tmpDir);
      const basePrompt = 'You are an analyst.';

      // Even after many invocations, analyst should never get self-check
      for (let i = 1; i <= 100; i++) {
        const result = applySelfCheck('analyst', basePrompt, 'sess-a');
        expect(result).not.toContain('Self-Check Assessment');
        expect(result).toBe(basePrompt);
      }
    });

    it('analyst counter still increments even though threshold is 0', () => {
      const { applySelfCheck, getRoundCounter } = createAdapterForSelfCheck(tmpDir);

      expect(getRoundCounter('analyst')).toBe(0);

      for (let i = 1; i <= 5; i++) {
        applySelfCheck('analyst', 'base', 'sess-a');
      }

      expect(getRoundCounter('analyst')).toBe(5);
    });

    it('analyst with explicit threshold 0 from config override never triggers', () => {
      const { applySelfCheck } = createAdapterForSelfCheck(tmpDir, {
        runtime: {
          ...makeMinimalConfig().runtime,
          selfCheck: { executor: 15, planner: 30, analyst: 0 },
        },
      });
      const basePrompt = 'You are an analyst.';

      for (let i = 1; i <= 50; i++) {
        expect(applySelfCheck('analyst', basePrompt, 'sess-a')).not.toContain('Self-Check Assessment');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Role change resets counters
  // ═══════════════════════════════════════════════════════════════

  describe('role change resets counters', () => {
    it('resets all round counters when role changes', () => {
      const { applySelfCheck, getRoundCounter, resetOnRoleChange } =
        createAdapterForSelfCheck(tmpDir);

      // Simulate real invokeAgent flow: set initial role first
      resetOnRoleChange('executor');

      // Build up executor counter to 14
      for (let i = 0; i < 14; i++) {
        applySelfCheck('executor', 'base', 'sess-1');
      }
      expect(getRoundCounter('executor')).toBe(14);

      // Simulate role change by calling resetOnRoleChange with planner
      resetOnRoleChange('planner');

      // All counters should be cleared
      expect(getRoundCounter('executor')).toBe(0);
      expect(getRoundCounter('planner')).toBe(0);
    });

    it('preserves counter when same role is used consecutively', () => {
      const { applySelfCheck, getRoundCounter, resetOnRoleChange } =
        createAdapterForSelfCheck(tmpDir);

      applySelfCheck('executor', 'base', 'sess-1');
      applySelfCheck('executor', 'base', 'sess-1');
      applySelfCheck('executor', 'base', 'sess-1');
      expect(getRoundCounter('executor')).toBe(3);

      // resetOnRoleChange with same role should not clear
      resetOnRoleChange('executor');
      expect(getRoundCounter('executor')).toBe(3);
    });

    it('after role change and back, executor counter starts fresh', () => {
      const { applySelfCheck, getRoundCounter, resetOnRoleChange } =
        createAdapterForSelfCheck(tmpDir);

      // Simulate real invokeAgent flow: set initial role first
      resetOnRoleChange('executor');

      // Run executor to 14
      for (let i = 0; i < 14; i++) {
        applySelfCheck('executor', 'base', 'sess-e');
      }
      expect(getRoundCounter('executor')).toBe(14);

      // Switch to planner
      resetOnRoleChange('planner');
      expect(getRoundCounter('executor')).toBe(0);

      // Run executor again
      applySelfCheck('executor', 'base', 'sess-e2');
      expect(getRoundCounter('executor')).toBe(1);
    });

    it('resetOnRoleChange sets lastRole correctly', () => {
      const { getLastRole, resetOnRoleChange } = createAdapterForSelfCheck(tmpDir);

      expect(getLastRole()).toBeNull();

      resetOnRoleChange('executor');
      expect(getLastRole()).toBe('executor');

      resetOnRoleChange('planner');
      expect(getLastRole()).toBe('planner');
    });

    it('resetOnRoleChange on null→executor does not clear (first invocation)', () => {
      const { getRoundCounter, resetOnRoleChange } = createAdapterForSelfCheck(tmpDir);

      // First role assignment — since lastRole was null, nothing to reset
      // (the condition requires lastRole !== null && lastRole !== role)
      // But since there are no counters yet, it doesn't matter
      resetOnRoleChange('executor');
      expect(getRoundCounter('executor')).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Event logging
  // ═══════════════════════════════════════════════════════════════

  describe('event logging', () => {
    it('logs self_check_triggered event via EventLogger when threshold is met', () => {
      const tmpDirEvent = setupTempProject();
      try {
        const eventLogger = new EventLogger(join(tmpDirEvent, '.saivage'));
        const { applySelfCheck } = createAdapterForSelfCheck(tmpDirEvent, undefined, eventLogger);
        const basePrompt = 'You are an executor.';

        // Run up to 14
        for (let i = 1; i <= 14; i++) {
          applySelfCheck('executor', basePrompt, 'sess-evt');
        }

        // 15th call triggers
        const result = applySelfCheck('executor', basePrompt, 'sess-evt');

        // Read events
        const events = eventLogger.getEvents({ kind: 'self_check_triggered' });
        expect(events.length).toBe(1);

        const scEvent = events[0] as SelfCheckTriggeredEvent;
        expect(scEvent.kind).toBe('self_check_triggered');
        expect(scEvent.session_id).toBe('sess-evt');
        expect(scEvent.rounds).toBe(15);
        expect(scEvent.threshold).toBe(15);

        eventLogger.close();
      } finally {
        rmSync(tmpDirEvent, { recursive: true, force: true });
      }
    });

    it('logs self_check_triggered event with correct role field', () => {
      const tmpDirEvent = setupTempProject();
      try {
        const eventLogger = new EventLogger(join(tmpDirEvent, '.saivage'));
        const { applySelfCheck } = createAdapterForSelfCheck(tmpDirEvent, undefined, eventLogger);
        const basePrompt = 'You are a planner.';

        // Planner threshold is 30
        for (let i = 1; i <= 29; i++) {
          applySelfCheck('planner', basePrompt, 'sess-pl');
        }
        applySelfCheck('planner', basePrompt, 'sess-pl');

        const events = eventLogger.getEvents({ kind: 'self_check_triggered' });
        expect(events.length).toBe(1);

        const scEvent = events[0] as SelfCheckTriggeredEvent;
        expect(scEvent.session_id).toBe('sess-pl');
        expect(scEvent.rounds).toBe(30);
        expect(scEvent.threshold).toBe(30);

        eventLogger.close();
      } finally {
        rmSync(tmpDirEvent, { recursive: true, force: true });
      }
    });

    it('does NOT log self_check_triggered event before threshold is met', () => {
      const tmpDirEvent = setupTempProject();
      try {
        const eventLogger = new EventLogger(join(tmpDirEvent, '.saivage'));
        const { applySelfCheck } = createAdapterForSelfCheck(tmpDirEvent, undefined, eventLogger);
        const basePrompt = 'You are an executor.';

        // Only 14 calls — no log expected
        for (let i = 1; i <= 14; i++) {
          applySelfCheck('executor', basePrompt, 'sess-evt');
        }

        const events = eventLogger.getEvents({ kind: 'self_check_triggered' });
        expect(events.length).toBe(0);

        eventLogger.close();
      } finally {
        rmSync(tmpDirEvent, { recursive: true, force: true });
      }
    });

    it('logs multiple events for multiple thresholds (15, 30, 45...)', () => {
      const tmpDirEvent = setupTempProject();
      try {
        const eventLogger = new EventLogger(join(tmpDirEvent, '.saivage'));
        const { applySelfCheck } = createAdapterForSelfCheck(tmpDirEvent, undefined, eventLogger);
        const basePrompt = 'You are an executor.';

        // Simulate 45 rounds
        for (let i = 1; i <= 45; i++) {
          applySelfCheck('executor', basePrompt, 'sess-multi');
        }

        const events = eventLogger.getEvents({ kind: 'self_check_triggered' });
        expect(events.length).toBe(3); // rounds 15, 30, 45

        const rounds = (events as SelfCheckTriggeredEvent[]).map((e) => e.rounds);
        expect(rounds).toContain(15);
        expect(rounds).toContain(30);
        expect(rounds).toContain(45);

        eventLogger.close();
      } finally {
        rmSync(tmpDirEvent, { recursive: true, force: true });
      }
    });

    it('emits self_check_triggered on EventBus when provided', () => {
      const tmpDirEvent = setupTempProject();
      try {
        const eventBus = new EventEmitter();
        const emitted: Array<Record<string, unknown>> = [];
        eventBus.on('self_check_triggered', (payload) => {
          emitted.push(payload as Record<string, unknown>);
        });

        const { applySelfCheck } = createAdapterForSelfCheck(tmpDirEvent, undefined, undefined, eventBus);
        const basePrompt = 'You are an executor.';

        for (let i = 1; i <= 14; i++) {
          applySelfCheck('executor', basePrompt, 'sess-bus');
        }
        applySelfCheck('executor', basePrompt, 'sess-bus');

        expect(emitted.length).toBe(1);
        expect(emitted[0].session_id).toBe('sess-bus');
        expect(emitted[0].role).toBe('executor');
        expect(emitted[0].rounds).toBe(15);
        expect(emitted[0].threshold).toBe(15);

        eventBus.removeAllListeners();
      } finally {
        rmSync(tmpDirEvent, { recursive: true, force: true });
      }
    });

    it('does NOT emit event for analyst (threshold=0)', () => {
      const tmpDirEvent = setupTempProject();
      try {
        const eventLogger = new EventLogger(join(tmpDirEvent, '.saivage'));
        const { applySelfCheck } = createAdapterForSelfCheck(tmpDirEvent, undefined, eventLogger);
        const basePrompt = 'You are an analyst.';

        for (let i = 1; i <= 100; i++) {
          applySelfCheck('analyst', basePrompt, 'sess-a');
        }

        const events = eventLogger.getEvents({ kind: 'self_check_triggered' });
        expect(events.length).toBe(0);

        eventLogger.close();
      } finally {
        rmSync(tmpDirEvent, { recursive: true, force: true });
      }
    });

    it('logs event with config override thresholds', () => {
      const tmpDirEvent = setupTempProject();
      try {
        const eventLogger = new EventLogger(join(tmpDirEvent, '.saivage'));
        const { applySelfCheck } = createAdapterForSelfCheck(tmpDirEvent, {
          runtime: {
            ...makeMinimalConfig().runtime,
            selfCheck: { executor: 5, planner: 10, analyst: 0 },
          },
        }, eventLogger);
        const basePrompt = 'You are an executor.';

        // Run to round 5
        for (let i = 1; i <= 4; i++) {
          applySelfCheck('executor', basePrompt, 'sess-ovr');
        }
        applySelfCheck('executor', basePrompt, 'sess-ovr');

        const events = eventLogger.getEvents({ kind: 'self_check_triggered' });
        expect(events.length).toBe(1);

        const scEvent = events[0] as SelfCheckTriggeredEvent;
        expect(scEvent.rounds).toBe(5);
        expect(scEvent.threshold).toBe(5);
        expect(scEvent.session_id).toBe('sess-ovr');

        eventLogger.close();
      } finally {
        rmSync(tmpDirEvent, { recursive: true, force: true });
      }
    });
  });
});

// ── Test Suite: No regressions from existing tests ────────────

describe('Self-check side effects are minimal', () => {
  it('AgentAdapter can be constructed without event logger', () => {
    const tmpDir = setupTempProject();
    try {
      const config = makeMinimalConfig();
      writeConfig(tmpDir, config);

      const adapter = new AgentAdapter({
        projectRoot: tmpDir,
        saivageDir: join(tmpDir, '.saivage'),
        config,
      });

      expect(adapter).toBeDefined();
      expect(adapter.config).toBe(config);
      expect(adapter.eventBus).toBeUndefined();
      expect(adapter.eventLogger).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('applySelfCheck returns unmodified prompt for threshold 0 roles', () => {
    const tmpDir = setupTempProject();
    try {
      const config = makeMinimalConfig({
        runtime: {
          ...makeMinimalConfig().runtime,
          selfCheck: { executor: 0, planner: 0, analyst: 0 },
        },
      });
      writeConfig(tmpDir, config);

      const adapter = new AgentAdapter({
        projectRoot: tmpDir,
        saivageDir: join(tmpDir, '.saivage'),
        config,
      });

      const applySelfCheck = (role: string, prompt: string, sid: string) =>
        (adapter as unknown as Record<string, Function>)['applySelfCheck'](role, prompt, sid);

      const basePrompt = 'You are an agent.';
      // After many calls, still no self-check appended
      for (let i = 0; i < 100; i++) {
        const result = applySelfCheck('executor', basePrompt, 'sess-z');
        expect(result).toBe(basePrompt);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('getRuntimeConfig includes selfCheck in returned section', () => {
    const config = makeMinimalConfig();
    const rt = getRuntimeConfig(config);
    expect(rt.selfCheck).toBeDefined();
    expect(rt.selfCheck?.executor).toBe(15);
    expect(rt.selfCheck?.planner).toBe(30);
    expect(rt.selfCheck?.analyst).toBe(0);
  });
});
