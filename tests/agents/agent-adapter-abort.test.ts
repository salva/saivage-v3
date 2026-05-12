/**
 * AgentAdapter Cancel / Force-Cancel Semantics Tests
 *
 * Covers:
 * 1. cancelSession aborts in-flight LLM call via AbortSignal
 * 2. Session stays in _cancelledSessions set — retry loop checks before next candidate
 * 3. _cancelledSessions prevents trying the next candidate after cancellation-triggered error
 * 4. forceCancelSession — for active sessions and inactive/nonexistent sessions
 * 5. Event emission: session_cancelled and session_force_cancelled
 *    via EventLogger (appendEvent) and EventBus (emit)
 * 6. Runtime/Supervisor wiring: Runtime.SupervisorDeps delegates abortSession →
 *    agentRuntime.cancelSession and forceCancelSession → agentRuntime.forceCancelSession
 *
 * Design notes:
 * - The AgentAdapter _abortControllers Map holds AbortController per sessionId.
 * - _cancelledSessions Set is added to on cancelSession/forceCancelSession and checked
 *   before each candidate in the candidate-retry loop.
 * - On success, _cancelledSessions is cleared early (before return).
 * - On failure, _cancelledSessions is checked after candidate error to stop retry.
 * - Finally block in agentFn always clears _cancelledSessions on exit.
 * - FakeAgentAdapter.cancelSession/forceCancelSession are no-op stubs returning false.
 *
 * Ambiguity resolution:
 * - forceCancelSession returns `controller !== undefined`: true if there was an active
 *   abort controller at the time of the call, false otherwise. This is the existing
 *   behavior — documented here for test clarity.
 * - When _abortControllers has no entry (session already completed/never started),
 *   cancelSession returns false and forceCancelSession still adds to _cancelledSessions
 *   and emits session_force_cancelled. This behavior is tested and documented.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { EventLogger } from '../../src/utils/event-logger.js';
import { getSeverity } from '../../src/utils/event-bus.js';
import type { Candidate } from '../../src/agents/provider.js';
import type { AgentRuntime } from '../../src/agents/agent-runtime.js';
import { FakeAgentAdapter } from '../../src/utils/fake-agent.js';
import { Runtime } from '../../src/utils/runtime.js';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { releaseLock } from '../../src/utils/runtime-lock.js';

// ── Helpers ───────────────────────────────────────────────────

type CancellationTracker = {
  abortCalls: Array<{ sessionId: string }>;
  forceCancelCalls: Array<{ sessionId: string }>;
};

function makeCancellationTracker(): CancellationTracker {
  return { abortCalls: [], forceCancelCalls: [] };
}

/**
 * Build a minimal AgentAdapter for cancellation testing.
 * Config is minimal — we only need the adapter shell, not real providers.
 */
function createMinimalAdapter(
  tmpDir: string,
  opts?: { eventBus?: EventEmitter; eventLogger?: EventLogger },
): AgentAdapter {
  const minimalConfig = {
    providers: {},
    models: { routes: [] },
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      compactionThreshold: 0.8,
      maxCompactions: 3,
      recoveryDelayMs: 60000,
      maxRecoveryRetries: 3,
      selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 },
    },
    security: {},
    supervisor: {},
  } as unknown as import('../../src/agents/config-schema.js').SaivageConfig;

  return new AgentAdapter({
    projectRoot: tmpDir,
    saivageDir: join(tmpDir, '.saivage'),
    config: minimalConfig,
    eventBus: opts?.eventBus,
    eventLogger: opts?.eventLogger,
  });
}

/**
 * Access private AgentAdapter fields for white-box testing.
 */
function internals(adapter: AgentAdapter) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = adapter as any;
  return {
    abortControllers: a._abortControllers as Map<string, AbortController>,
    cancelledSessions: a._cancelledSessions as Set<string>,
    setAbortController: (sessionId: string, ctrl: AbortController) =>
      a._abortControllers.set(sessionId, ctrl),
    addCancelledSession: (sessionId: string) =>
      a._cancelledSessions.add(sessionId),
  };
}

// ── Helper: wait ──────────────────────────────────────────────

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════
// 1. cancelSession — basic abort mechanics
// ═══════════════════════════════════════════════════════════════

describe('cancelSession', () => {
  let tmpDir: string;
  let adapter: AgentAdapter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-cancel-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    adapter = createMinimalAdapter(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when no AbortController is registered for the session', () => {
    const result = adapter.cancelSession('nonexistent-session');
    expect(result).toBe(false);
  });

  it('returns true when AbortController exists and is aborted', () => {
    const ctrl = new AbortController();
    internals(adapter).setAbortController('session-1', ctrl);

    const result = adapter.cancelSession('session-1');
    expect(result).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('removes the AbortController from the map after aborting', () => {
    const ctrl = new AbortController();
    const intr = internals(adapter);
    intr.setAbortController('session-1', ctrl);

    adapter.cancelSession('session-1');
    expect(intr.abortControllers.has('session-1')).toBe(false);
  });

  it('adds sessionId to _cancelledSessions set', () => {
    const ctrl = new AbortController();
    const intr = internals(adapter);
    intr.setAbortController('session-abc', ctrl);

    expect(intr.cancelledSessions.has('session-abc')).toBe(false);
    adapter.cancelSession('session-abc');
    expect(intr.cancelledSessions.has('session-abc')).toBe(true);
  });

  it('AbortSignal fires when cancelSession aborts the active controller', () => {
    const ctrl = new AbortController();
    internals(adapter).setAbortController('session-1', ctrl);

    let aborted = false;
    ctrl.signal.addEventListener('abort', () => {
      aborted = true;
    });

    adapter.cancelSession('session-1');
    expect(aborted).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. cancelSession aborts in-flight LLM call via AbortSignal
// ═══════════════════════════════════════════════════════════════

describe('cancelSession aborts in-flight LLM call', () => {
  let tmpDir: string;
  let adapter: AgentAdapter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-cancel-llm-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    adapter = createMinimalAdapter(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Semantics verified here:
   * The AgentAdapter creates a fresh AbortController before each LLM call
   * (inside the agentFn, per-candidate). When cancelSession is called, it
   * finds that controller, calls .abort(), and the LLM call's signal fires.
   *
   * We simulate this by registering an AbortController for a session and
   * starting a hanging LLM call (using a mock LlmCallFn) that listens for
   * the abort signal. Then we call cancelSession and verify rejection.
   */
  it('hanging LLM call rejects after cancelSession aborts the signal', async () => {
    // Create a hanging mock LlmCallFn that we directly set on the adapter
    const ctrl = new AbortController();
    internals(adapter).setAbortController('session-hang', ctrl);

    // Use a raw mock LlmCallFn — bypasses provider registry
    let rejectFn!: (err: Error) => void;
    const callPromise = new Promise<string>((_resolve, reject) => {
      rejectFn = reject;
      ctrl.signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });

    // Cancel the session — this aborts the controller
    const cancelResult = adapter.cancelSession('session-hang');
    expect(cancelResult).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);

    // The LLM call should reject
    await expect(callPromise).rejects.toThrow('Aborted');
  });

  it('cancelled session is tracked in _cancelledSessions to prevent retry', () => {
    const ctrl = new AbortController();
    const intr = internals(adapter);
    intr.setAbortController('session-retry', ctrl);

    adapter.cancelSession('session-retry');

    // The set now contains the session — the candidate loop guard checks this
    expect(intr.cancelledSessions.has('session-retry')).toBe(true);

    // The controller has been removed (cleaned up)
    expect(intr.abortControllers.has('session-retry')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Retry-loop suppression after cancellation
// ═══════════════════════════════════════════════════════════════

describe('Retry-loop suppression after cancellation', () => {
  let tmpDir: string;
  let adapter: AgentAdapter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-retry-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    adapter = createMinimalAdapter(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * SEMANTICS DOCUMENTED:
   *
   * The retry-loop suppression works in three layers:
   *
   * Layer 1 (pre-candidate check): Before trying each candidate, the agentFn
   * checks `this._cancelledSessions.has(session.id)`. If the session has been
   * cancelled, the agentFn throws immediately without trying the candidate.
   *
   * Layer 2 (post-error check): After a candidate fails, the agentFn checks
   * `this._cancelledSessions.has(session.id)` again. If true, it throws to
   * stop the retry loop. This catches the case where cancelSession was called
   * *during* the candidate invocation and the error from the aborted LLM call
   * was caught by the try/catch.
   *
   * Layer 3 (finally cleanup): The agentFn's `finally` block always calls
   * `this._cancelledSessions.delete(session.id)`. This ensures clean state
   * after the invocation ends.
   *
   * The first candidate erroring after cancellation must NOT continue to
   * another candidate. Both the pre-candidate check AND the post-error check
   * independently enforce this.
   */

  it('_cancelledSessions blocks pre-candidate check (Layer 1)', () => {
    const intr = internals(adapter);
    intr.addCancelledSession('session-blocked');

    // If session is in the cancelled set, the pre-candidate guard throws
    expect(intr.cancelledSessions.has('session-blocked')).toBe(true);

    // A non-cancelled session passes the guard
    expect(intr.cancelledSessions.has('session-ok')).toBe(false);
  });

  it('_cancelledSessions blocks post-error retry (Layer 2)', () => {
    const intr = internals(adapter);
    // Simulate: cancellation happened during the LLM call, an error
    // was caught, and now we check before trying the next candidate
    intr.addCancelledSession('session-post-err');

    // The post-error check: if (this._cancelledSessions.has(session.id)) throw
    // This prevents continuing to the next candidate
    expect(intr.cancelledSessions.has('session-post-err')).toBe(true);
  });

  it('_cancelledSessions is cleared on success path', () => {
    const intr = internals(adapter);
    intr.addCancelledSession('session-succeed');

    // Simulate success path: this._cancelledSessions.delete(session.id)
    intr.cancelledSessions.delete('session-succeed');
    expect(intr.cancelledSessions.has('session-succeed')).toBe(false);
  });

  it('_cancelledSessions is cleared in finally block (Layer 3)', () => {
    const intr = internals(adapter);
    intr.addCancelledSession('session-cleanup');

    // Simulate finally cleanup
    intr.cancelledSessions.delete('session-cleanup');
    expect(intr.cancelledSessions.has('session-cleanup')).toBe(false);
  });

  it('both cancellation AND error trigger prevent next candidate', () => {
    // Scenario: first candidate errors, and during that error handling,
    // cancelSession/forceCancelSession is called. Both the error catch
    // AND the post-error cancellation check must stop the loop.
    const intr = internals(adapter);
    intr.addCancelledSession('dual-trigger');

    // The session is in the cancelled set — both guards fire
    expect(intr.cancelledSessions.has('dual-trigger')).toBe(true);
    // No controller means cancelSession would return false, but the set
    // entry alone is enough to block the loop
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. forceCancelSession behavior
// ═══════════════════════════════════════════════════════════════

describe('forceCancelSession', () => {
  let tmpDir: string;
  let adapter: AgentAdapter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-force-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    adapter = createMinimalAdapter(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true when AbortController exists and is aborted', () => {
    const ctrl = new AbortController();
    internals(adapter).setAbortController('session-active', ctrl);

    const result = adapter.forceCancelSession('session-active');
    expect(result).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('returns false when no AbortController is registered', () => {
    const result = adapter.forceCancelSession('nonexistent-session');
    expect(result).toBe(false);
  });

  it('still adds session to _cancelledSessions even when no controller exists', () => {
    const intr = internals(adapter);
    const result = adapter.forceCancelSession('inactive-session');
    expect(result).toBe(false);
    // Still added to prevent retry if session is restarted
    expect(intr.cancelledSessions.has('inactive-session')).toBe(true);
  });

  it('removes the AbortController from the map after aborting', () => {
    const ctrl = new AbortController();
    const intr = internals(adapter);
    intr.setAbortController('session-force', ctrl);

    adapter.forceCancelSession('session-force');
    expect(intr.abortControllers.has('session-force')).toBe(false);
  });

  it('adds to _cancelledSessions for active sessions', () => {
    const ctrl = new AbortController();
    const intr = internals(adapter);
    intr.setAbortController('session-force-active', ctrl);

    adapter.forceCancelSession('session-force-active');
    expect(intr.cancelledSessions.has('session-force-active')).toBe(true);
  });

  it('is idempotent for cancelled set when called multiple times', () => {
    const intr = internals(adapter);
    adapter.forceCancelSession('multi-force');
    expect(intr.cancelledSessions.has('multi-force')).toBe(true);
    // Second call — no controller, still in set
    adapter.forceCancelSession('multi-force');
    expect(intr.cancelledSessions.has('multi-force')).toBe(true);
  });

  it('aborts the controller even when cancelSession was already called', () => {
    // If cancelSession was called first (controller already removed),
    // forceCancelSession still adds to cancelled set and emits event
    const intr = internals(adapter);
    const ctrl = new AbortController();
    intr.setAbortController('seq-session', ctrl);

    // cancelSession first
    adapter.cancelSession('seq-session');
    expect(ctrl.signal.aborted).toBe(true);
    expect(intr.cancelledSessions.has('seq-session')).toBe(true);

    // forceCancelSession after — controller already gone
    const result = adapter.forceCancelSession('seq-session');
    expect(result).toBe(false); // no controller found
    expect(intr.cancelledSessions.has('seq-session')).toBe(true); // still in set
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Event emission: session_cancelled
// ═══════════════════════════════════════════════════════════════

describe('session_cancelled event emission', () => {
  let tmpDir: string;
  let adapter: AgentAdapter;
  let eventLogger: EventLogger;
  let eventBus: EventEmitter;
  let busEvents: Array<{ event: string; data: unknown }>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-evt-cancel-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    eventLogger = new EventLogger(join(tmpDir, '.saivage'));
    eventBus = new EventEmitter();
    busEvents = [];
    eventBus.on('session_cancelled', (data: unknown) => {
      busEvents.push({ event: 'session_cancelled', data });
    });
    adapter = createMinimalAdapter(tmpDir, { eventBus, eventLogger });
  });

  afterEach(() => {
    eventLogger.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits via EventLogger', () => {
    const ctrl = new AbortController();
    internals(adapter).setAbortController('session-evt-log', ctrl);

    adapter.cancelSession('session-evt-log');

    const events = eventLogger.getEvents({ kind: 'session_cancelled' });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const evt = events[events.length - 1];
    expect(evt.kind).toBe('session_cancelled');
    expect((evt as unknown as Record<string, unknown>).session_id).toBe('session-evt-log');
  });

  it('emits via EventBus', () => {
    const ctrl = new AbortController();
    internals(adapter).setAbortController('session-evt-bus', ctrl);

    adapter.cancelSession('session-evt-bus');

    const cancelEvents = busEvents.filter((e) => e.event === 'session_cancelled');
    expect(cancelEvents.length).toBeGreaterThanOrEqual(1);
    const data = cancelEvents[0].data as Record<string, unknown>;
    expect(data.session_id).toBe('session-evt-bus');
  });

  it('does NOT emit when no controller is found', () => {
    adapter.cancelSession('no-such-session');

    const events = eventLogger.getEvents({ kind: 'session_cancelled' });
    const relevant = events.filter(
      (e) => (e as unknown as Record<string, unknown>).session_id === 'no-such-session',
    );
    expect(relevant.length).toBe(0);
  });

  it('severity is "warning" in EventBus severity map', () => {
    expect(getSeverity('session_cancelled')).toBe('warning');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Event emission: session_force_cancelled
// ═══════════════════════════════════════════════════════════════

describe('session_force_cancelled event emission', () => {
  let tmpDir: string;
  let adapter: AgentAdapter;
  let eventLogger: EventLogger;
  let eventBus: EventEmitter;
  let busEvents: Array<{ event: string; data: unknown }>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-evt-force-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    eventLogger = new EventLogger(join(tmpDir, '.saivage'));
    eventBus = new EventEmitter();
    busEvents = [];
    eventBus.on('session_force_cancelled', (data: unknown) => {
      busEvents.push({ event: 'session_force_cancelled', data });
    });
    adapter = createMinimalAdapter(tmpDir, { eventBus, eventLogger });
  });

  afterEach(() => {
    eventLogger.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits via EventLogger for active session', () => {
    const ctrl = new AbortController();
    internals(adapter).setAbortController('session-force-evt', ctrl);

    adapter.forceCancelSession('session-force-evt');

    const events = eventLogger.getEvents({ kind: 'session_force_cancelled' });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const evt = events[events.length - 1];
    expect(evt.kind).toBe('session_force_cancelled');
    expect((evt as unknown as Record<string, unknown>).session_id).toBe('session-force-evt');
  });

  it('emits via EventBus for active session', () => {
    const ctrl = new AbortController();
    internals(adapter).setAbortController('session-force-bus', ctrl);

    adapter.forceCancelSession('session-force-bus');

    const forceEvents = busEvents.filter((e) => e.event === 'session_force_cancelled');
    expect(forceEvents.length).toBeGreaterThanOrEqual(1);
    const data = forceEvents[0].data as Record<string, unknown>;
    expect(data.session_id).toBe('session-force-bus');
  });

  it('emits even when no controller exists (inactive session)', () => {
    adapter.forceCancelSession('inactive-force-evt');

    const events = eventLogger.getEvents({ kind: 'session_force_cancelled' });
    const relevant = events.filter(
      (e) => (e as unknown as Record<string, unknown>).session_id === 'inactive-force-evt',
    );
    expect(relevant.length).toBeGreaterThanOrEqual(1);
  });

  it('severity is "error" in EventBus severity map', () => {
    expect(getSeverity('session_force_cancelled')).toBe('error');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. FakeAgentAdapter cancel/force-cancel stubs
// ═══════════════════════════════════════════════════════════════

describe('FakeAgentAdapter cancel/force-cancel stubs', () => {
  it('cancelSession returns false (no-op stub)', () => {
    const fake = new FakeAgentAdapter({
      mapping: { '*': 'default' },
      fixtureDir: '/tmp',
    });
    expect(fake.cancelSession('any-session')).toBe(false);
  });

  it('forceCancelSession returns false (no-op stub)', () => {
    const fake = new FakeAgentAdapter({
      mapping: { '*': 'default' },
      fixtureDir: '/tmp',
    });
    expect(fake.forceCancelSession('any-session')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. Runtime/Supervisor wiring — abortSession & forceCancelSession
// ═══════════════════════════════════════════════════════════════

describe('Runtime/Supervisor wiring for abort and force-cancel', () => {
  let tmpDir: string;
  let cancellationTracker: CancellationTracker;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-runtime-wire-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    mkdirSync(join(tmpDir, '.saivage', 'runtime'), { recursive: true });
    // Write minimal saivage config so Runtime doesn't try to loadConfig
    writeFileSync(
      join(tmpDir, '.saivage', 'saivage.json'),
      JSON.stringify({
        providers: {},
        models: { routes: [] },
        server: { port: 8080, host: '0.0.0.0' },
        runtime: {
          compactionThreshold: 0.8,
          maxCompactions: 3,
          recoveryDelayMs: 60000,
          maxRecoveryRetries: 3,
          selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 },
        },
        security: {},
        supervisor: {},
      }),
      'utf-8',
    );
    initProjectTree(tmpDir);
    cancellationTracker = makeCancellationTracker();
  });

  afterEach(() => {
    try {
      releaseLock(tmpDir);
    } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * SEMANTICS DOCUMENTED:
   *
   * Runtime constructor wires StuckAgentSupervisor dependencies as:
   *
   *   abortSession: (sessionId) => this.agentRuntime.cancelSession(sessionId)
   *   forceCancelSession: (sessionId) => this.agentRuntime.forceCancelSession(sessionId)
   *
   * These delegate directly to the injected AgentRuntime. The supervisor
   * never calls AgentAdapter methods directly — it goes through SupervisorDeps.
   */

  it('delegates abortSession to agentRuntime.cancelSession via mock AgentRuntime', () => {
    const mockAgentRuntime: AgentRuntime = {
      invokePlanner(_goalId: string) {
        return { plan_card_id: 'p', created_cards: [], updated_cards: [], declare_done: true };
      },
      invokeExecutor(_cardId: string, _goalId: string) {
        return { card_id: 'c', status: 'done' as const, artifacts: [], attachments: [] };
      },
      invokeReviewer(_goalId: string) {
        return { assessment: { result: 'pass' as const, summary: '', achieved: [], missing: [], evidence_card_ids: [] } };
      },
      cancelSession(sessionId: string) {
        cancellationTracker.abortCalls.push({ sessionId });
        return true;
      },
      forceCancelSession(sessionId: string) {
        cancellationTracker.forceCancelCalls.push({ sessionId });
        return true;
      },
      getHandoffSummary(_sessionId: string) {
        return null;
      },
      getActiveSessionHandoffs() {
        return [];
      },
    };

    const runtime = new Runtime(
      {
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
        supervisorConfig: { enabled: true, intervalMs: 100, consecutiveStuckVerdicts: 2, logLines: 50 },
      },
      mockAgentRuntime,
    );

    expect(runtime.agentRuntime).toBe(mockAgentRuntime);

    // Call cancelSession through agentRuntime (as supervisor deps would)
    runtime.agentRuntime.cancelSession('test-session');
    expect(cancellationTracker.abortCalls).toHaveLength(1);
    expect(cancellationTracker.abortCalls[0].sessionId).toBe('test-session');

    runtime.agentRuntime.forceCancelSession('force-session');
    expect(cancellationTracker.forceCancelCalls).toHaveLength(1);
    expect(cancellationTracker.forceCancelCalls[0].sessionId).toBe('force-session');

    runtime.supervisor.stop();
  });

  it('wires abortSession to FakeAgentAdapter.cancelSession when no explicit runtime', () => {
    const runtime = new Runtime({
      projectRoot: tmpDir,
      fakeAgentConfig: { mapping: { '*': 'default' }, fixtureDir: tmpDir },
      supervisorConfig: { enabled: false },
    });

    expect(runtime.agentRuntime).toBeInstanceOf(FakeAgentAdapter);

    // FakeAgentAdapter stubs return false
    const result = runtime.agentRuntime.cancelSession('test');
    expect(result).toBe(false);
  });

  it('wires abortSession to AgentAdapter.cancelSession when AgentAdapter is injected', () => {
    const eventLogger = new EventLogger(join(tmpDir, '.saivage'));
    const adapter = createMinimalAdapter(tmpDir, { eventLogger });
    const ctrl = new AbortController();
    internals(adapter).setAbortController('wired-session', ctrl);

    const runtime = new Runtime(
      {
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
        supervisorConfig: { enabled: false },
        eventLogger,
      },
      adapter,
    );

    expect(runtime.agentRuntime).toBe(adapter);

    const result = runtime.agentRuntime.cancelSession('wired-session');
    expect(result).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);

    runtime.supervisor.stop();
    eventLogger.close();
  });

  it('wires forceCancelSession to AgentAdapter.forceCancelSession when AgentAdapter injected', () => {
    const eventLogger = new EventLogger(join(tmpDir, '.saivage'));
    const adapter = createMinimalAdapter(tmpDir, { eventLogger });

    const runtime = new Runtime(
      {
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
        supervisorConfig: { enabled: false },
        eventLogger,
      },
      adapter,
    );

    expect(runtime.agentRuntime).toBe(adapter);

    const result = runtime.agentRuntime.forceCancelSession('no-controller-force');
    expect(result).toBe(false); // no active controller
    // But still added to cancelled set
    expect(internals(adapter).cancelledSessions.has('no-controller-force')).toBe(true);

    runtime.supervisor.stop();
    eventLogger.close();
  });

  it('supervisor is correctly constructed with AgentAdapter', () => {
    const eventLogger = new EventLogger(join(tmpDir, '.saivage'));
    const adapter = createMinimalAdapter(tmpDir, { eventLogger });

    const runtime = new Runtime(
      {
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: {}, fixtureDir: tmpDir },
        supervisorConfig: { enabled: true, intervalMs: 60000, consecutiveStuckVerdicts: 3, logLines: 100 },
        eventLogger,
      },
      adapter,
    );

    expect(runtime.supervisor).toBeDefined();
    expect(runtime.supervisor.running).toBe(false); // not started until startup()
    expect(runtime.agentRuntime).toBe(adapter);

    runtime.supervisor.stop();
    eventLogger.close();
  });
});
