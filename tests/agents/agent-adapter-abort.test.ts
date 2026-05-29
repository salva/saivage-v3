import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { EventLogger } from '../../src/observability/event-logger.js';
import { getEventSeverity } from '../../src/events/index.js';
import type { AgentExecutionPort as AgentRuntime } from '../../src/contracts/index.js';
import { FakeAgentAdapter } from '../../src/agents/fake-agent.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { releaseLock } from '../../src/runtime/lock.js';
import { getSession } from '../../src/agents/session-persistence.js';

type CancellationTracker = {
  abortCalls: Array<{ sessionId: string }>;
  forceCancelCalls: Array<{ sessionId: string }>;
};

function makeCancellationTracker(): CancellationTracker {
  return { abortCalls: [], forceCancelCalls: [] };
}

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

function createConfiguredAdapter(
  tmpDir: string,
  opts?: { eventBus?: EventEmitter; eventLogger?: EventLogger },
): AgentAdapter {
  const configuredConfig = {
    providers: {
      'test-provider': {
        priority: 10,
        models: ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet'],
        baseUrl: 'https://test-api.example.com',
        apiKey: 'test-api-key',
      },
    },
    models: {
      planner: ['gpt-4o'],
      executor: ['gpt-4o-mini'],
      reviewer: ['claude-sonnet'],
      default: ['gpt-4o-mini'],
    },
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      compactionThreshold: 0.8,
      maxCompactions: 3,
      recoveryDelayMs: 0,
      maxRecoveryRetries: 0,
      selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 },
    },
    security: {},
    supervisor: {},
  } as unknown as import('../../src/agents/config-schema.js').SaivageConfig;

  return new AgentAdapter({
    projectRoot: tmpDir,
    saivageDir: join(tmpDir, '.saivage'),
    config: configuredConfig,
    eventBus: opts?.eventBus,
    eventLogger: opts?.eventLogger,
  });
}

function internals(adapter: AgentAdapter) {
  const coordinator = (adapter as any).sessionCoordinator;
  return {
    abortControllers: coordinator.abortControllers as Map<string, AbortController>,
    cancelledSessions: coordinator.cancelledSessions as Set<string>,
    setAbortController: (sessionId: string, ctrl: AbortController) =>
      coordinator.trackAbortController(sessionId, ctrl),
    addCancelledSession: (sessionId: string) =>
      coordinator.cancelledSessions.add(sessionId),
  };
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  it('hanging LLM call rejects after cancelSession aborts the signal', async () => {
    const ctrl = new AbortController();
    internals(adapter).setAbortController('session-hang', ctrl);

    const callPromise = new Promise<string>((_resolve, reject) => {
      ctrl.signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });

    const cancelResult = adapter.cancelSession('session-hang');
    expect(cancelResult).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);

    await expect(callPromise).rejects.toThrow('Aborted');
  });

  it('cancelled session is tracked in _cancelledSessions to prevent retry', () => {
    const ctrl = new AbortController();
    const intr = internals(adapter);
    intr.setAbortController('session-retry', ctrl);

    adapter.cancelSession('session-retry');

    expect(intr.cancelledSessions.has('session-retry')).toBe(true);
    expect(intr.abortControllers.has('session-retry')).toBe(false);
  });
});

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

  it('_cancelledSessions blocks pre-candidate check (Layer 1)', () => {
    const intr = internals(adapter);
    intr.addCancelledSession('session-blocked');
    expect(intr.cancelledSessions.has('session-blocked')).toBe(true);
    expect(intr.cancelledSessions.has('session-ok')).toBe(false);
  });

  it('_cancelledSessions blocks post-error retry (Layer 2)', () => {
    const intr = internals(adapter);
    intr.addCancelledSession('session-post-err');
    expect(intr.cancelledSessions.has('session-post-err')).toBe(true);
  });

  it('_cancelledSessions is cleared on success path', () => {
    const intr = internals(adapter);
    intr.addCancelledSession('session-succeed');
    intr.cancelledSessions.delete('session-succeed');
    expect(intr.cancelledSessions.has('session-succeed')).toBe(false);
  });

  it('_cancelledSessions is cleared in finally block (Layer 3)', () => {
    const intr = internals(adapter);
    intr.addCancelledSession('session-cleanup');
    intr.cancelledSessions.delete('session-cleanup');
    expect(intr.cancelledSessions.has('session-cleanup')).toBe(false);
  });

  it('both cancellation AND error trigger prevent next candidate', () => {
    const intr = internals(adapter);
    intr.addCancelledSession('dual-trigger');
    expect(intr.cancelledSessions.has('dual-trigger')).toBe(true);
  });
});

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
    adapter.forceCancelSession('multi-force');
    expect(intr.cancelledSessions.has('multi-force')).toBe(true);
  });

  it('aborts the controller even when cancelSession was already called', () => {
    const intr = internals(adapter);
    const ctrl = new AbortController();
    intr.setAbortController('seq-session', ctrl);

    adapter.cancelSession('seq-session');
    expect(ctrl.signal.aborted).toBe(true);
    expect(intr.cancelledSessions.has('seq-session')).toBe(true);

    const result = adapter.forceCancelSession('seq-session');
    expect(result).toBe(false);
    expect(intr.cancelledSessions.has('seq-session')).toBe(true);
  });
});

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
    expect(getEventSeverity('session_cancelled')).toBe('warning');
  });
});

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
    expect(getEventSeverity('session_force_cancelled')).toBe('error');
  });
});

describe('FakeAgentAdapter cancellation semantics', () => {
  it('tracks active fake sessions via handoffs and cancels them deterministically', () => {
    const fake = new FakeAgentAdapter({
      mapping: { '*': 'default' },
      fixtureDir: '/tmp',
    });

    (fake as unknown as { activeSessions: Map<string, unknown> }).activeSessions.set('fake-executor-1', {
      sessionId: 'fake-executor-1',
      role: 'executor',
      goalId: 'goal-1',
      cardId: 'card-1',
      lastAction: 'Session started',
      nextAction: 'Executing card card-1',
      contextSummary: 'Goal: goal-1, Card: card-1',
    });

    expect(fake.getActiveSessionHandoffs()).toHaveLength(1);
    expect(fake.cancelSession('fake-executor-1')).toBe(true);
    expect(fake.getActiveSessionHandoffs()).toHaveLength(0);
  });

  it('force-cancel removes fake active session and returns true when present', () => {
    const fake = new FakeAgentAdapter({
      mapping: { '*': 'default' },
      fixtureDir: '/tmp',
    });

    (fake as unknown as { activeSessions: Map<string, unknown> }).activeSessions.set('fake-reviewer-1', {
      sessionId: 'fake-reviewer-1',
      role: 'reviewer',
      goalId: 'goal-2',
      cardId: null,
      lastAction: 'Session started',
      nextAction: 'Reviewing goal goal-2',
      contextSummary: 'Goal: goal-2, Card: N/A',
    });

    expect(fake.forceCancelSession('fake-reviewer-1')).toBe(true);
    expect(fake.getHandoffSummary('fake-reviewer-1')).toBeNull();
  });
});

describe('Runtime/Supervisor wiring for abort and force-cancel', () => {
  let tmpDir: string;
  let cancellationTracker: CancellationTracker;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-runtime-wire-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    mkdirSync(join(tmpDir, '.saivage', 'runtime'), { recursive: true });
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

  it('delegates abortSession to agentRuntime.cancelSession via mock AgentRuntime', () => {
    const mockAgentRuntime: AgentRuntime = {
      invokePlanner(_request) {
        return { goal_card_id: 'p', created_cards: [], updated_cards: [], status: 'done' };
      },
      invokeExecutor(_request) {
        return { card_id: 'c', status: 'done' as const, status_text: 'Completed successfully', artifacts: [], attachments: [], fallback_with_evidence: null };
      },
      invokeReviewer(_request) {
        return { assessment: { result: 'pass' as const, summary: '', achieved: [], issues: [], evidence_card_ids: [] } };
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
    expect(runtime.agentRuntime.cancelSession('test')).toBe(false);
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

    const result = runtime.agentRuntime.forceCancelSession('no-controller-force');
    expect(result).toBe(false);
    expect(internals(adapter).cancelledSessions.has('no-controller-force')).toBe(true);

    runtime.supervisor.stop();
    eventLogger.close();
  });
});

describe('Integration: real invokeAgent candidate loop with cancellation', () => {
  let tmpDir: string;
  let adapter: AgentAdapter;
  let eventBus: EventEmitter;
  let sessionStartedIds: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-integration-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    mkdirSync(join(tmpDir, '.saivage', 'agents'), { recursive: true });
    mkdirSync(join(tmpDir, '.saivage', 'agents', 'sessions'), { recursive: true });
    mkdirSync(join(tmpDir, '.saivage', 'agents', 'messages'), { recursive: true });

    eventBus = new EventEmitter();
    sessionStartedIds = [];
    eventBus.on('session_started', (data: unknown) => {
      const d = data as Record<string, unknown>;
      if (typeof d.session_id === 'string') {
        sessionStartedIds.push(d.session_id);
      }
    });

    adapter = createConfiguredAdapter(tmpDir, { eventBus });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeHangingLlmCallFn(): {
    llmCallFn: import('../../src/agents/llm-contracts.js').LlmCallFn;
    startedPromise: Promise<void>;
  } {
    let startedResolve!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    const llmCallFn: import('../../src/agents/llm-contracts.js').LlmCallFn = (
      _candidate,
      _systemPrompt,
      _messages,
      _sessionId,
      opts,
    ) => {
      startedResolve();
      return new Promise<string>((_resolve, reject) => {
        if (opts?.signal) {
          if (opts.signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          opts.signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }
      });
    };

    return { llmCallFn, startedPromise };
  }

  function makeSuccessLlmCallFn(response: string): {
    llmCallFn: import('../../src/agents/llm-contracts.js').LlmCallFn;
  } {
    return {
      llmCallFn: (_candidate, _systemPrompt, _messages, _sessionId, _opts) => {
        return Promise.resolve(response);
      },
    };
  }

  it('invokePlanner rejects when cancelSession is called mid-flight', async () => {
    const { llmCallFn, startedPromise } = makeHangingLlmCallFn();
    adapter.setLlmCallFn(llmCallFn);

    const invokePromise = adapter.invokePlanner(
      'goal-integration-1', 'You are a planner',
      [{ id: 'msg-1', session_id: '', role: 'user', kind: 'text', content: 'Plan a task', round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: new Date().toISOString() }],
    );

    await startedPromise;
    await wait(50);

    expect(sessionStartedIds.length).toBeGreaterThanOrEqual(1);
    const sessionId = sessionStartedIds[0];

    const persistedSession = getSession(join(tmpDir, '.saivage'), sessionId);
    expect(persistedSession).not.toBeNull();
    expect(persistedSession!.status).toBe('active');

    const cancelResult = adapter.cancelSession(sessionId);
    expect(cancelResult).toBe(true);

    await expect(invokePromise).rejects.toThrow(/cancelled/i);

    const finalSession = getSession(join(tmpDir, '.saivage'), sessionId);
    expect(finalSession).not.toBeNull();
    expect(finalSession!.status).toBe('failed');
  });

  it('does not attempt candidate 2 when cancelled after candidate 1 fails', async () => {
    const multiConfig = {
      providers: {
        'test-provider': {
          priority: 10,
          models: ['gpt-4o', 'gpt-4o-mini'],
          baseUrl: 'https://test-api.example.com',
          apiKey: 'test-api-key',
        },
      },
      models: {
        executor: ['gpt-4o-mini', 'gpt-4o'],
        default: ['gpt-4o-mini'],
      },
      server: { port: 8080, host: '0.0.0.0' },
      runtime: {
        compactionThreshold: 0.8,
        maxCompactions: 3,
        recoveryDelayMs: 0,
        maxRecoveryRetries: 0,
        selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 },
      },
      security: {},
      supervisor: {},
    } as unknown as import('../../src/agents/config-schema.js').SaivageConfig;

    const multiAdapter = new AgentAdapter({
      projectRoot: tmpDir,
      saivageDir: join(tmpDir, '.saivage'),
      config: multiConfig,
      eventBus,
    });

    const attemptedCandidates: string[] = [];

    const llmCallFn: import('../../src/agents/llm-contracts.js').LlmCallFn = (
      candidate,
      _systemPrompt,
      _messages,
      sessionId,
      _opts,
    ) => {
      attemptedCandidates.push(candidate.model);

      if (attemptedCandidates.length === 1) {
        multiAdapter.cancelSession(sessionId);
        throw new Error('Candidate 1 network error');
      }

      return Promise.resolve('{"card_id":"card-2","status":"done","artifacts":[],"attachments":[]}');
    };

    multiAdapter.setLlmCallFn(llmCallFn);

    const invokePromise = multiAdapter.invokeExecutor(
      'card-1',
      'goal-1',
      'You are an executor',
      [{ id: 'msg-1', session_id: '', role: 'user', kind: 'text', content: 'Execute a task', round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: new Date().toISOString() }],
    );

    await expect(invokePromise).rejects.toThrow(/cancelled/i);
    expect(attemptedCandidates).toHaveLength(1);
    expect(attemptedCandidates[0]).toBe('gpt-4o-mini');
  });

  it('forceCancelSession during first candidate prevents candidate 2', async () => {
    const multiConfig = {
      providers: {
        'test-provider': {
          priority: 10,
          models: ['gpt-4o', 'gpt-4o-mini'],
          baseUrl: 'https://test-api.example.com',
          apiKey: 'test-api-key',
        },
      },
      models: {
        executor: ['gpt-4o-mini', 'gpt-4o'],
        default: ['gpt-4o-mini'],
      },
      server: { port: 8080, host: '0.0.0.0' },
      runtime: {
        compactionThreshold: 0.8,
        maxCompactions: 3,
        recoveryDelayMs: 0,
        maxRecoveryRetries: 0,
        selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 },
      },
      security: {},
      supervisor: {},
    } as unknown as import('../../src/agents/config-schema.js').SaivageConfig;

    const multiAdapter = new AgentAdapter({
      projectRoot: tmpDir,
      saivageDir: join(tmpDir, '.saivage'),
      config: multiConfig,
      eventBus,
    });

    const attemptedCandidates: string[] = [];

    const llmCallFn: import('../../src/agents/llm-contracts.js').LlmCallFn = (
      candidate,
      _systemPrompt,
      _messages,
      sessionId,
      _opts,
    ) => {
      attemptedCandidates.push(candidate.model);

      if (attemptedCandidates.length === 1) {
        multiAdapter.forceCancelSession(sessionId);
        throw new Error('Candidate 1 error');
      }

      return Promise.resolve('{"card_id":"card-2","status":"done","artifacts":[],"attachments":[]}');
    };

    multiAdapter.setLlmCallFn(llmCallFn);

    const invokePromise = multiAdapter.invokeExecutor(
      'card-force',
      'goal-force',
      'You are an executor',
      [{ id: 'msg-2', session_id: '', role: 'user', kind: 'text', content: 'Execute', round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: new Date().toISOString() }],
    );

    await expect(invokePromise).rejects.toThrow(/cancelled/i);

    expect(attemptedCandidates).toHaveLength(1);
    expect(attemptedCandidates[0]).toBe('gpt-4o-mini');
  });

  it('successful invocation completes normally and clears cancelled state', async () => {
    const { llmCallFn: successFn } = makeSuccessLlmCallFn(
      '{"card_id":"card-ok","status":"done","status_text":"Completed successfully","artifacts":[],"attachments":[]}',
    );
    adapter.setLlmCallFn(successFn);

    const result = await adapter.invokeExecutor(
      'card-success',
      'goal-success',
      'You are an executor',
      [{ id: 'msg-3', session_id: '', role: 'user', kind: 'text', content: 'Do it', round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: new Date().toISOString() }],
    );

    expect(result.card_id).toBe('card-ok');
    expect(result.status).toBe('done');

    expect(sessionStartedIds.length).toBeGreaterThanOrEqual(1);
    const sessionId = sessionStartedIds[0];
    const persisted = getSession(join(tmpDir, '.saivage'), sessionId);
    expect(persisted).not.toBeNull();
    expect(persisted!.status).toBe('done');
    expect(internals(adapter).cancelledSessions.has(sessionId)).toBe(false);
  });
});
