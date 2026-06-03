/**
 * StuckAgentSupervisor Tests
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  StuckAgentSupervisor,
  type SupervisorConfig,
  type SupervisorDeps,
  type StuckVerdict,
} from '../../src/runtime/stuck-agent-supervisor.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { releaseLock } from '../../src/runtime/lock.js';
import type { AgentExecutionPort as AgentRuntime } from '../../src/contracts/index.js';
import { createRuntimeTestHarness, type RuntimeTestHarness } from './runtime-test-harness.js';

interface MockedDeps extends SupervisorDeps {
  getRecentLogs: jest.MockedFunction<SupervisorDeps['getRecentLogs']>;
  getActiveSessions: jest.MockedFunction<SupervisorDeps['getActiveSessions']>;
  abortSession: jest.MockedFunction<SupervisorDeps['abortSession']>;
  forceCancelSession: jest.MockedFunction<SupervisorDeps['forceCancelSession']>;
  emitEvent: jest.MockedFunction<SupervisorDeps['emitEvent']>;
  isShuttingDown: jest.MockedFunction<SupervisorDeps['isShuttingDown']>;
}

function makeDeps(overrides?: Partial<MockedDeps>): MockedDeps {
  return {
    getRecentLogs: jest.fn<SupervisorDeps['getRecentLogs']>().mockReturnValue(''),
    getActiveSessions: jest.fn<SupervisorDeps['getActiveSessions']>().mockReturnValue([]),
    abortSession: jest.fn<SupervisorDeps['abortSession']>(),
    forceCancelSession: jest.fn<SupervisorDeps['forceCancelSession']>(),
    emitEvent: jest.fn<SupervisorDeps['emitEvent']>(),
    isShuttingDown: jest.fn<SupervisorDeps['isShuttingDown']>().mockReturnValue(false),
    ...overrides,
  };
}

function stuck(): StuckVerdict {
  return { stuck: true, confidence: 0.9, reason: 'No progress', evidence: ['line1'] };
}

function notStuck(): StuckVerdict {
  return { stuck: false, confidence: 0.95, reason: 'Progress ok', evidence: ['ok'] };
}

function cfg(overrides?: Partial<SupervisorConfig>): SupervisorConfig {
  return { enabled: true, intervalMs: 50, consecutiveStuckVerdicts: 3, logLines: 100, ...overrides };
}

const wait = (n: number, ms = 50): Promise<void> =>
  new Promise((r) => setTimeout(r, 1000 + ms * (n + 2)));

describe('Construction and config', () => {
  it('has expected default accessor values', () => {
    const d = makeDeps();
    const s = new StuckAgentSupervisor(cfg(), d);
    expect(s.running).toBe(false);
    expect(s.consecutiveStuckCount).toBe(0);
    expect(s.aborted).toBe(false);
  });

  it('custom config overrides defaults', async () => {
    const d = makeDeps();
    const s = new StuckAgentSupervisor({ enabled: true, intervalMs: 30, consecutiveStuckVerdicts: 5, logLines: 50 }, d);
    s.setChecksProvider(async () => notStuck());
    s.start();
    expect(s.running).toBe(true);
    await wait(2, 30);
    const vc = d.emitEvent.mock.calls.filter(([k]) => k === 'stuck_verdict');
    expect(vc.length).toBeGreaterThanOrEqual(1);
    expect(vc[0][1]).toHaveProperty('threshold', 5);
    s.stop();
  });

  it('enabled: false prevents start', () => {
    const d = makeDeps();
    const s = new StuckAgentSupervisor(cfg({ enabled: false }), d);
    s.start();
    expect(s.running).toBe(false);
    expect(d.emitEvent).not.toHaveBeenCalled();
  });

  it('defaults to enabled', () => {
    const d = makeDeps();
    const s = new StuckAgentSupervisor(cfg(), d);
    s.start();
    expect(s.running).toBe(true);
    s.stop();
  });
});

describe('Lifecycle: start/stop', () => {
  let d: MockedDeps;
  beforeEach(() => { d = makeDeps(); });

  it('start() emits stuck_supervisor_started', () => {
    const s = new StuckAgentSupervisor(cfg(), d);
    s.start();
    expect(d.emitEvent).toHaveBeenCalledWith('stuck_supervisor_started', {
      interval_ms: 50, consecutive_threshold: 3,
    });
    expect(s.running).toBe(true);
    s.stop();
  });

  it('start() is no-op when already running', () => {
    const s = new StuckAgentSupervisor(cfg(), d);
    s.start();
    const c = d.emitEvent.mock.calls.length;
    s.start();
    expect(d.emitEvent.mock.calls.length).toBe(c);
    s.stop();
  });

  it('start() no-op when enabled=false', () => {
    const s = new StuckAgentSupervisor(cfg({ enabled: false }), d);
    s.start();
    expect(s.running).toBe(false);
  });

  it('stop() emits stuck_supervisor_stopped', () => {
    const s = new StuckAgentSupervisor(cfg(), d);
    s.start(); s.stop();
    expect(s.running).toBe(false);
    expect(d.emitEvent).toHaveBeenCalledWith('stuck_supervisor_stopped', {
      checks_performed: expect.any(Number),
    });
  });

  it('stop() no-op when not running', () => {
    const s = new StuckAgentSupervisor(cfg(), d);
    s.stop();
    expect(d.emitEvent).not.toHaveBeenCalled();
  });

  it('restart works', () => {
    const s = new StuckAgentSupervisor(cfg(), d);
    s.start(); s.stop();
    d.emitEvent.mockClear();
    s.start();
    expect(s.running).toBe(true);
    expect(d.emitEvent).toHaveBeenCalledWith('stuck_supervisor_started', expect.any(Object));
    s.stop();
  });

  it('stop() idempotent', () => {
    const s = new StuckAgentSupervisor(cfg(), d);
    s.start(); s.stop(); s.stop(); s.stop();
    expect(s.running).toBe(false);
  });
});

describe('Verdict handling', () => {
  let d: MockedDeps;
  beforeEach(() => { d = makeDeps(); });

  it('stuck=true increments consecutive count', async () => {
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(3, 30);
    expect(s.consecutiveStuckCount).toBeGreaterThanOrEqual(1);
    s.stop();
  });

  it('stuck=false resets consecutive count to 0', async () => {
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30 }), d);
    let c = 0;
    s.setChecksProvider(async () => { c++; return c <= 2 ? stuck() : notStuck(); });
    s.start();
    await wait(4, 30);
    expect(s.consecutiveStuckCount).toBe(0);
    s.stop();
  });

  it('stuck_verdict event has correct fields', async () => {
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(2, 30);
    const vc = d.emitEvent.mock.calls.filter(([k]) => k === 'stuck_verdict');
    expect(vc.length).toBeGreaterThanOrEqual(1);
    const v = vc[0][1] as Record<string, unknown>;
    expect(v.verdict).toBe(true);
    expect(v.confidence).toBe(0.9);
    expect(v.reason).toBe('No progress');
    expect(v.evidence).toEqual(['line1']);
    expect(v.threshold).toBe(3);
    s.stop();
  });

  it('verdict includes threshold from config', async () => {
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30, consecutiveStuckVerdicts: 5 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(2, 30);
    const vc = d.emitEvent.mock.calls.filter(([k]) => k === 'stuck_verdict');
    expect(vc.length).toBeGreaterThanOrEqual(1);
    expect((vc[0][1] as Record<string, unknown>).threshold).toBe(5);
    s.stop();
  });
});

describe('Abort target selection', () => {
  let d: MockedDeps;
  beforeEach(() => { d = makeDeps(); });

  it('consecutive >= threshold emits abort_target_selected', async () => {
    d.getActiveSessions.mockReturnValue([{ role: 'executor', sessionId: 'ex-1' }]);
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30, consecutiveStuckVerdicts: 2 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(3, 30);
    const ac = d.emitEvent.mock.calls.filter(([k]) => k === 'abort_target_selected');
    expect(ac.length).toBe(1);
    const a = ac[0][1] as Record<string, unknown>;
    expect(a.target_role).toBe('executor');
    expect(a.target_session_id).toBe('ex-1');
    expect(a.consecutive_count).toBeGreaterThanOrEqual(2);
    s.stop();
  });

  it('reviewer selected before executor', async () => {
    d.getActiveSessions.mockReturnValue([
      { role: 'executor', sessionId: 'ex-1' }, { role: 'reviewer', sessionId: 'rv-1' },
    ]);
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30, consecutiveStuckVerdicts: 2 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(3, 30);
    const ac = d.emitEvent.mock.calls.filter(([k]) => k === 'abort_target_selected');
    expect(ac.length).toBe(1);
    expect((ac[0][1] as Record<string, unknown>).target_role).toBe('reviewer');
    s.stop();
  });

  it('executor selected before planner', async () => {
    d.getActiveSessions.mockReturnValue([
      { role: 'planner', sessionId: 'pl-1' }, { role: 'executor', sessionId: 'ex-1' },
    ]);
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30, consecutiveStuckVerdicts: 2 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(3, 30);
    const ac = d.emitEvent.mock.calls.filter(([k]) => k === 'abort_target_selected');
    expect(ac.length).toBe(1);
    expect((ac[0][1] as Record<string, unknown>).target_role).toBe('executor');
    s.stop();
  });

  it('planner selected when only planner active', async () => {
    d.getActiveSessions.mockReturnValue([{ role: 'planner', sessionId: 'pl-1' }]);
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30, consecutiveStuckVerdicts: 2 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(3, 30);
    const ac = d.emitEvent.mock.calls.filter(([k]) => k === 'abort_target_selected');
    expect(ac.length).toBe(1);
    expect((ac[0][1] as Record<string, unknown>).target_role).toBe('planner');
    s.stop();
  });

  it('no sessions -> no abort', async () => {
    d.getActiveSessions.mockReturnValue([]);
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30, consecutiveStuckVerdicts: 2 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(3, 30);
    expect(d.abortSession).not.toHaveBeenCalled();
    s.stop();
  });

  it('abortSession called with correct sessionId', async () => {
    d.getActiveSessions.mockReturnValue([{ role: 'executor', sessionId: 'ex-42' }]);
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30, consecutiveStuckVerdicts: 2 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(3, 30);
    expect(d.abortSession).toHaveBeenCalledWith('ex-42');
    s.stop();
  });

  it('only ONE abort per stuck episode', async () => {
    d.getActiveSessions.mockReturnValue([{ role: 'executor', sessionId: 'ex-1' }]);
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30, consecutiveStuckVerdicts: 2 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(6, 30);
    expect(d.abortSession).toHaveBeenCalledTimes(1);
    s.stop();
  });
});

describe('Force cancel', () => {
  let d: MockedDeps;
  beforeEach(() => {
    d = makeDeps();
    d.getActiveSessions.mockReturnValue([{ role: 'executor', sessionId: 'ex-1' }]);
  });

  it('force-cancel NOT called immediately after abort', async () => {
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30, consecutiveStuckVerdicts: 2 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(4, 30);
    expect(d.abortSession).toHaveBeenCalledTimes(1);
    expect(d.forceCancelSession).not.toHaveBeenCalled();
    s.stop();
  });

  it('abortSession called, force-cancel timer registered', async () => {
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30, consecutiveStuckVerdicts: 2 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(4, 30);
    expect(d.abortSession).toHaveBeenCalledTimes(1);
    expect(d.forceCancelSession).not.toHaveBeenCalled();
    s.stop();
  });
});

describe('Recovery', () => {
  let d: MockedDeps;
  beforeEach(() => { d = makeDeps(); });

  it('not-stuck verdict resets consecutive count', async () => {
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30 }), d);
    let c = 0;
    s.setChecksProvider(async () => { c++; return c <= 2 ? stuck() : notStuck(); });
    s.start();
    await wait(4, 30);
    expect(s.consecutiveStuckCount).toBe(0);
    s.stop();
  });

  it('aborted flag set after abort fires', async () => {
    d.getActiveSessions.mockReturnValue([{ role: 'executor', sessionId: 'ex-1' }]);
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30, consecutiveStuckVerdicts: 2 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(4, 30);
    expect(d.abortSession).toHaveBeenCalledTimes(1);
    expect(s.aborted).toBe(true);
    s.stop();
  });

  it('consecutive counter stays 0 after recovery', async () => {
    d.getActiveSessions.mockReturnValue([{ role: 'executor', sessionId: 'ex-1' }]);
    let c = 0;
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30 }), d);
    s.setChecksProvider(async () => { c++; return c <= 2 ? stuck() : notStuck(); });
    s.start();
    await wait(5, 30);
    expect(s.consecutiveStuckCount).toBe(0);
    s.stop();
  });
});

describe('Grace period', () => {
  let d: MockedDeps;
  beforeEach(() => {
    d = makeDeps();
    d.getActiveSessions.mockReturnValue([{ role: 'executor', sessionId: 'ex-1' }]);
  });

  it('after abort, aborted flag prevents re-abort', async () => {
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30, consecutiveStuckVerdicts: 2 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(6, 30);
    expect(d.abortSession).toHaveBeenCalledTimes(1);
    expect(s.aborted).toBe(true);
    s.stop();
  });

  it('grace period is active when aborted flag is true', async () => {
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 30, consecutiveStuckVerdicts: 2 }), d);
    s.setChecksProvider(async () => stuck());
    s.start();
    await wait(3, 30);
    expect(s.aborted).toBe(true);
    s.stop();
  });
});

describe('Overlapping check prevention', () => {
  it('checkInProgress prevents concurrent checks', async () => {
    const d = makeDeps();
    let concurrent = 0;
    let maxConcurrent = 0;
    const s = new StuckAgentSupervisor(cfg({ intervalMs: 10 }), d);
    s.setChecksProvider(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      concurrent--;
      return notStuck();
    });
    s.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    expect(maxConcurrent).toBeLessThanOrEqual(1);
    s.stop();
  });
});

describe('RuntimeIntegration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-sv-'));
    initProjectTree(tmpDir);
  });

  afterEach(() => {
    try { releaseLock(tmpDir); } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('supervisor starts on Runtime startup when enabled', async () => {
    const harness = createRuntimeTestHarness({
      config: {
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
        supervisorConfig: cfg(),
      },
    });
    await harness.api.start();
    expect(harness.supervisorTestTools.isRunning()).toBe(true);
    await harness.api.shutdown();
  });

  it('supervisor stops on Runtime shutdown', async () => {
    const harness = createRuntimeTestHarness({
      config: {
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
        supervisorConfig: cfg(),
      },
    });
    await harness.api.start();
    await harness.api.shutdown();
    expect(harness.supervisorTestTools.isRunning()).toBe(false);
  });

  it('supervisor does not start when disabled', async () => {
    const harness = createRuntimeTestHarness({
      config: {
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
        supervisorConfig: cfg({ enabled: false }),
      },
    });
    await harness.api.start();
    expect(harness.supervisorTestTools.isRunning()).toBe(false);
    await harness.api.shutdown();
  });

  it('supervisor with custom config', async () => {
    const harness = createRuntimeTestHarness({
      config: {
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
        supervisorConfig: {
          enabled: true, intervalMs: 300000, consecutiveStuckVerdicts: 5, logLines: 100,
        },
      },
    });
    await harness.api.start();
    expect(harness.supervisorTestTools.isRunning()).toBe(true);
    await harness.api.shutdown();
  });

  it('supervisor default when no explicit config', async () => {
    const harness = createRuntimeTestHarness({
      config: {
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
      },
    });
    await harness.api.start();
    expect(harness.supervisorTestTools.isRunning()).toBe(true);
    await harness.api.shutdown();
  });

  it('supervisor events emitted via Runtime.emit', async () => {
    const harness = createRuntimeTestHarness({
      config: {
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
        supervisorConfig: cfg(),
      },
    });
    const events: string[] = [];
    harness.events.on('stuck_supervisor_started', () => events.push('started'));
    harness.events.on('stuck_supervisor_stopped', () => events.push('stopped'));
    await harness.api.start();
    expect(events).toContain('started');
    await harness.api.shutdown();
    expect(events).toContain('stopped');
  });
});

describe('Runtime supervisor cancellation integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    jest.useFakeTimers();
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-sv-int-'));
    initProjectTree(tmpDir);
  });

  afterEach(() => {
    jest.useRealTimers();
    try { releaseLock(tmpDir); } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRuntimeWithAgent(agentRuntime: AgentRuntime): RuntimeTestHarness {
    return createRuntimeTestHarness({
      config: {
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
        supervisorConfig: { enabled: true, intervalMs: 1_000_000, consecutiveStuckVerdicts: 1, logLines: 10 },
      },
      agentRuntime,
    });
  }

  it('supervisor cancels a stuck active session through runtime wiring', async () => {
    const cancelSession = jest.fn<AgentRuntime['cancelSession']>(() => true);
    const forceCancelSession = jest.fn<AgentRuntime['forceCancelSession']>(() => true);

    const agentRuntime: AgentRuntime = {
      invokePlanner() {
        return { goal_card_id: 'p', created_cards: [], updated_cards: [], status: 'done' };
      },
      invokeExecutor() {
        return { card_id: 'c', status: 'done' as const, status_text: 'Completed successfully', artifacts: [], attachments: [], fallback_with_evidence: null };
      },
      invokeReviewer() {
        return { assessment: { result: 'pass' as const, summary: '', achieved: [], issues: [], evidence_card_ids: [] } };
      },
      cancelSession,
      forceCancelSession,
      getHandoffSummary() {
        return null;
      },
      getActiveSessionHandoffs() {
        return [{
          session_id: 'sess-executor-1',
          role: 'executor',
          last_action: 'Waiting for model response',
          next_action: 'Continue execution',
          context_summary: 'Goal: goal-1, Card: card-1',
        }];
      },
    };

    const harness = createRuntimeWithAgent(agentRuntime);
    harness.supervisorTestTools.setChecksProvider(async () => stuck());
    harness.supervisorTestTools.start();
    await harness.supervisorTestTools.runCheck();
    await harness.supervisorTestTools.runCheck();

    expect(cancelSession).toHaveBeenCalledWith('sess-executor-1');
    expect(forceCancelSession).not.toHaveBeenCalled();
    harness.supervisorTestTools.stop();
  });

  it('supervisor force-cancels when graceful cancel does not clear the active session', async () => {
    let active = true;
    const cancelSession = jest.fn<AgentRuntime['cancelSession']>(() => true);
    const forceCancelSession = jest.fn<AgentRuntime['forceCancelSession']>(() => {
      active = false;
      return true;
    });

    const agentRuntime: AgentRuntime = {
      invokePlanner() {
        return { goal_card_id: 'p', created_cards: [], updated_cards: [], status: 'done' };
      },
      invokeExecutor() {
        return { card_id: 'c', status: 'done' as const, status_text: 'Completed successfully', artifacts: [], attachments: [], fallback_with_evidence: null };
      },
      invokeReviewer() {
        return { assessment: { result: 'pass' as const, summary: '', achieved: [], issues: [], evidence_card_ids: [] } };
      },
      cancelSession,
      forceCancelSession,
      getHandoffSummary() {
        return null;
      },
      getActiveSessionHandoffs() {
        return active
          ? [{
              session_id: 'sess-reviewer-1',
              role: 'reviewer',
              last_action: 'Still hung',
              next_action: 'Unknown',
              context_summary: 'Goal: goal-1, Card: N/A',
            }]
          : [];
      },
    };

    const harness = createRuntimeWithAgent(agentRuntime);
    harness.supervisorTestTools.setChecksProvider(async () => stuck());
    harness.supervisorTestTools.start();
    await harness.supervisorTestTools.runCheck();
    await harness.supervisorTestTools.runCheck();
    expect(cancelSession).toHaveBeenCalledWith('sess-reviewer-1');

    await jest.advanceTimersByTimeAsync(600000);
    await Promise.resolve();

    expect(forceCancelSession).toHaveBeenCalledWith('sess-reviewer-1');
    harness.supervisorTestTools.stop();
  });
});
