import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStateMachine, type RuntimeScheduler, type RuntimeSchedulerHandle } from '../../src/runtime/state-machine.js';
import { initRuntimeState, readRuntimeState, RuntimeStateInvariantError, updateRuntimeState } from '../../src/runtime/state.js';
import { CardStore } from '../../src/cards/card-store.js';
import { ErrorLogger } from '../../src/observability/error-logger.js';
import type { RuntimeState } from '../../src/schemas/types.js';
import type { CardLifecycleState } from '../../src/schemas/index.js';

function root(): string { return mkdtempSync(join(tmpdir(), 'saivage-state-machine-')); }

class FakeScheduler implements RuntimeScheduler {
  handlers: Array<{ handle: RuntimeSchedulerHandle; fn: () => void; ms: number; active: boolean }> = [];
  setInterval(fn: () => void, ms: number): RuntimeSchedulerHandle {
    const handle = {} as RuntimeSchedulerHandle;
    this.handlers.push({ handle, fn, ms, active: true });
    return handle;
  }
  clearInterval(handle: RuntimeSchedulerHandle): void {
    const entry = this.handlers.find((h) => h.handle === handle);
    if (entry) entry.active = false;
  }
  async fire(handle: RuntimeSchedulerHandle): Promise<void> {
    const entry = this.handlers.find((h) => h.handle === handle && h.active);
    if (entry) {
      entry.fn();
      // Allow the void-returning fn() body (an async tick()) to flush.
      await new Promise((r) => setImmediate(r));
    }
  }
}

function buildMachine(projectRoot: string, opts?: { clock?: () => Date; redispatch?: (cardId: string) => void }): { machine: RuntimeStateMachine; scheduler: FakeScheduler; errorLogger: ErrorLogger } {
  const cardStore = new CardStore(projectRoot);
  const errorLogger = new ErrorLogger(join(projectRoot, '.saivage'));
  const scheduler = new FakeScheduler();
  const machine = new RuntimeStateMachine({
    cards: {
      readStatus: (cardId) => cardStore.read(cardId)?.status,
      canTransition: (from, to) => cardStore.canTransition(from, to),
      setStatus: (cardId, status) => { cardStore.setStatus(cardId, status); },
    },
    state: {
      read: () => readRuntimeState(projectRoot),
      patch: (changes: Partial<RuntimeState>) => updateRuntimeState(projectRoot, changes),
    },
    errors: errorLogger,
    clock: { now: opts?.clock ?? (() => new Date()) },
    scheduler,
    redispatch: { redispatch: opts?.redispatch ?? (() => { /* noop */ }) },
    tickIntervalMs: 5000,
  });
  return { machine, scheduler, errorLogger };
}

function activeRun(cardId = 'goal-a'): NonNullable<RuntimeState['active_card_run']> {
  return {
    card_id: cardId,
    card_type: 'goal',
    ownership: { kind: 'direct', source: 'project_root' },
  runtime_status: 'running',
    phase: 'planner',
    caller_session_id: null,
    caller_tool_call_id: null,
    planner_session_id: `planner:${cardId}`,
    correction_attempts: 0,
    started_at: '2026-05-24T10:00:00.000Z',
    last_turn_at: '2026-05-24T10:00:00.000Z',
  };
}

describe('RuntimeStateMachine (Step 2 skeleton)', () => {
  it('start() registers an interval with the injected scheduler; stop() clears it', () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      const { machine, scheduler } = buildMachine(projectRoot);
      machine.start();
      expect(scheduler.handlers.length).toBe(1);
      expect(scheduler.handlers[0]!.active).toBe(true);
      expect(scheduler.handlers[0]!.ms).toBe(5000);
      machine.stop();
      expect(scheduler.handlers[0]!.active).toBe(false);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('tick() stamps last_tick_at on disk', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      const fixed = new Date('2026-05-24T10:00:00.000Z');
      const { machine } = buildMachine(projectRoot, { clock: () => fixed });
      await machine.tick();
      const state = readRuntimeState(projectRoot)!;
      expect(state.last_tick_at).toBe(fixed.toISOString());
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('on-demand transition(\'tick\') is gated by the re-entrancy lock', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      let ticks = 0;
      // Inject a clock side-effect that re-enters transition('tick') during the
      // first call; the re-entrancy lock must short-circuit the second call.
      const machineRef: { current: RuntimeStateMachine | null } = { current: null };
      const clock = jest.fn<() => Date>(() => {
        ticks += 1;
        if (ticks === 1 && machineRef.current !== null) {
          void machineRef.current.transition('tick');
        }
        return new Date('2026-05-24T10:00:00.000Z');
      });
      const cardStore = new CardStore(projectRoot);
      const errorLogger = new ErrorLogger(join(projectRoot, '.saivage'));
      const scheduler = new FakeScheduler();
      const machine = new RuntimeStateMachine({
        cards: {
          readStatus: (cardId) => cardStore.read(cardId)?.status,
          canTransition: (from, to) => cardStore.canTransition(from, to),
          setStatus: (cardId, status) => { cardStore.setStatus(cardId, status); },
        },
        state: {
          read: () => readRuntimeState(projectRoot),
          patch: (changes: Partial<RuntimeState>) => updateRuntimeState(projectRoot, changes),
        },
        errors: errorLogger,
        clock: { now: clock },
        scheduler,
        redispatch: { redispatch: () => undefined },
      });
      machineRef.current = machine;
      await machine.tick();
      // Exactly one clock observation should have been made; the re-entrant
      // call short-circuited before reading the clock a second time.
      expect(clock).toHaveBeenCalledTimes(1);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('logs exactly one state_machine_invariant for an I4 backwards-clock violation', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      const times = [
        new Date('2026-05-24T10:00:05.000Z'),
        new Date('2026-05-24T10:00:00.000Z'), // backwards
        new Date('2026-05-24T10:00:00.000Z'), // still backwards, but same tuple — must not double-log
      ];
      let idx = 0;
      const { machine, errorLogger } = buildMachine(projectRoot, { clock: () => times[idx++]! });
      await machine.tick();
      await machine.tick();
      await machine.tick();
      const errs = errorLogger.getErrors().filter((e) => e.code === 'state_machine_invariant' && e.invariant === 'I4');
      expect(errs.length).toBe(1);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('tick with running/no active run throws and does not patch to idle', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      updateRuntimeState(projectRoot, { status: 'running', active_card_run: null });
      const { machine, errorLogger } = buildMachine(projectRoot);
      await expect(machine.tick()).rejects.toThrow(RuntimeStateInvariantError);
      const stateAfter = readRuntimeState(projectRoot)!;
      expect(stateAfter.status).toBe('running');
      expect(stateAfter.active_card_run).toBeNull();
      const i1 = errorLogger.getErrors().filter((e) => e.code === 'state_machine_invariant' && e.invariant === 'I1');
      expect(i1.length).toBe(1);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('tick with idle/non-null active run throws and does not patch to running', async () => {
    const errors: Record<string, unknown>[] = [];
    const current: RuntimeState = {
      status: 'idle',
      project_id: 'project',
      pid: 1,
      started_at: '2026-05-24T10:00:00.000Z',
      active_card_run: activeRun(),
      paused: false,
      paused_at: null,
      updated_at: '2026-05-24T10:00:00.000Z',
      last_tick_at: null,
      runtime_intent: { status: 'stopped', updated_at: '2026-05-24T10:00:00.000Z', source_command_id: null },
      runtime_commands: [],
      runtime_runs: [],
      runtime_activations: [],
    };
    const machine = new RuntimeStateMachine({
      cards: {
        readStatus: () => 'running',
        canTransition: () => true,
        setStatus: () => undefined,
      },
      state: {
        read: () => current,
        patch: (changes) => Object.assign(current, changes),
      },
      errors: { appendError: (error) => { errors.push(error); } },
      clock: { now: () => new Date('2026-05-24T10:00:00.000Z') },
      scheduler: new FakeScheduler(),
      redispatch: { redispatch: () => undefined },
    });
    await expect(machine.tick()).rejects.toThrow(RuntimeStateInvariantError);
    expect(current.status).toBe('idle');
    expect(current.active_card_run).toEqual(expect.objectContaining({ card_id: 'goal-a' }));
    expect(errors.filter((e) => e.code === 'state_machine_invariant' && e.invariant === 'I1')).toHaveLength(1);
  });

  it('active card read failure propagates during tick', async () => {
    const current: RuntimeState = {
      status: 'running',
      project_id: 'project',
      pid: 1,
      started_at: '2026-05-24T10:00:00.000Z',
      active_card_run: activeRun(),
      paused: false,
      paused_at: null,
      updated_at: '2026-05-24T10:00:00.000Z',
      last_tick_at: null,
      runtime_intent: { status: 'stopped', updated_at: '2026-05-24T10:00:00.000Z', source_command_id: null },
      runtime_commands: [],
      runtime_runs: [],
      runtime_activations: [],
    };
    const machine = new RuntimeStateMachine({
      cards: {
        readStatus: () => { throw new Error('read status boom'); },
        canTransition: () => true,
        setStatus: () => undefined,
      },
      state: { read: () => current, patch: (changes) => Object.assign(current, changes) },
      errors: { appendError: () => undefined },
      clock: { now: () => new Date('2026-05-24T10:00:00.000Z') },
      scheduler: new FakeScheduler(),
      redispatch: { redispatch: () => undefined },
    });
    await expect(machine.tick()).rejects.toThrow('read status boom');
  });

  it('redispatch failure propagates during tick', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      updateRuntimeState(projectRoot, {
        runtime_intent: { status: 'running', source_command_id: 'cmd-1', updated_at: '2026-05-24T10:00:00.000Z' },
        runtime_runs: [{ run_id: 'root', kind: 'root', ownership: { kind: 'direct', source: 'project_root' }, card_id: 'project', parent_run_id: null, command_id: 'cmd-1', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: null, started_at: '2026-05-24T10:00:00.000Z', updated_at: '2026-05-24T10:00:00.000Z' }],
      });
      const { machine } = buildMachine(projectRoot, { redispatch: () => { throw new Error('redispatch boom'); } });
      await expect(machine.tick()).rejects.toThrow('redispatch boom');
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('scheduled tick rejection is recorded at the scheduler boundary', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      updateRuntimeState(projectRoot, {
        runtime_intent: { status: 'running', source_command_id: 'cmd-1', updated_at: '2026-05-24T10:00:00.000Z' },
        runtime_runs: [{ run_id: 'root', kind: 'root', ownership: { kind: 'direct', source: 'project_root' }, card_id: 'project', parent_run_id: null, command_id: 'cmd-1', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: null, started_at: '2026-05-24T10:00:00.000Z', updated_at: '2026-05-24T10:00:00.000Z' }],
      });
      const { machine, scheduler, errorLogger } = buildMachine(projectRoot, { redispatch: () => { throw new Error('redispatch boom'); } });
      machine.start();
      await scheduler.fire(scheduler.handlers[0]!.handle);
      const errs = errorLogger.getErrors().filter((e) => e.code === 'state_machine_scheduled_tick_failed');
      expect(errs).toEqual([expect.objectContaining({ message: 'redispatch boom' })]);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});

describe('RuntimeStateMachine.transitionCard (Step 5 decomposition)', () => {
  function seed(cardStore: CardStore, status: import('../../src/schemas/types.js').CardStatus): string {
    const now = new Date().toISOString();
    const card = cardStore.create({
      type: 'code',
      parent: null,
      title: 't',
      description: 'd',
      status,
      lifecycle: lifecycleForStatus(status, now),
      depends_on: [],
      priority: 5,
      tags: [],
      urgency: 'normal',
      created_by: 'planner',
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
      retries: 0,
      depth: 0,
    });
    return card.id;
  }

  function lifecycleForStatus(status: import('../../src/schemas/types.js').CardStatus, now: string): CardLifecycleState {
    if (status === 'done') return { status, result: { kind: 'planner_done', summary: 'done' }, error: null, completed_at: now };
    if (status === 'failed') return { status, result: { kind: 'executor_failure', error: 'failed', partial_result: null, latest_self_report: { result: 'failed', outcome: 'failed', summary: 'failed', status_text: 'failed', at: now } }, error: 'failed', completed_at: now };
    if (status === 'blocked') return { status, result: { kind: 'planner_blocked', blocked_reason: 'blocked', resume_reason: 'planner_blocked' }, error: 'blocked', completed_at: null };
    if (status === 'needs_verification') return { status, result: { kind: 'executor_needs_verification', reason: 'needs verification', preserved_result: {}, fallback_reason: null, latest_self_report: { result: 'needs_verification', outcome: 'needs_verification', summary: 'needs verification', status_text: 'needs verification', at: now } }, error: null, completed_at: null };
    return { status, result: null, error: null, completed_at: status === 'cancelled' ? now : null } as CardLifecycleState;
  }

  function build(projectRoot: string): { cardStore: CardStore; machine: RuntimeStateMachine; setStatusCalls: Array<{ id: string; status: string }>; errorLogger: ErrorLogger } {
    const cardStore = new CardStore(projectRoot);
    const errorLogger = new ErrorLogger(join(projectRoot, '.saivage'));
    const scheduler = new FakeScheduler();
    const setStatusCalls: Array<{ id: string; status: string }> = [];
    const origSetStatus = cardStore.setStatus.bind(cardStore);
    jest.spyOn(cardStore, 'setStatus').mockImplementation((id: string, status: import('../../src/schemas/types.js').CardStatus) => {
      setStatusCalls.push({ id, status });
      return origSetStatus(id, status);
    });
    const machine = new RuntimeStateMachine({
      cards: {
        readStatus: (cardId) => cardStore.read(cardId)?.status,
        canTransition: (from, to) => cardStore.canTransition(from, to),
        setStatus: (cardId, status) => { cardStore.setStatus(cardId, status); },
      },
      state: {
        read: () => readRuntimeState(projectRoot),
        patch: (changes: Partial<RuntimeState>) => updateRuntimeState(projectRoot, changes),
      },
      errors: errorLogger,
      clock: { now: () => new Date() },
      scheduler,
      redispatch: { redispatch: () => undefined },
    });
    return { cardStore, machine, setStatusCalls, errorLogger };
  }

  const cases: Array<{ name: string; from: import('../../src/schemas/types.js').CardStatus; action: import('../../src/runtime/state-machine.js').RuntimeCardAction; payload?: Record<string, unknown>; expected: import('../../src/schemas/types.js').CardStatus[] }> = [
    { name: 'start from drafting', from: 'drafting', action: 'start', expected: ['backlog', 'active', 'running'] },
    { name: 'start from backlog', from: 'backlog', action: 'start', expected: ['active', 'running'] },
    { name: 'restart from failed', from: 'failed', action: 'restart', expected: ['backlog', 'active', 'running'] },
    { name: 'restart from cancelled', from: 'cancelled', action: 'restart', expected: ['drafting', 'backlog', 'active', 'running'] },
    { name: 'fail from running', from: 'running', action: 'fail', expected: [] },
    { name: 'fail from drafting', from: 'drafting', action: 'fail', expected: [] },
    { name: 'block from active', from: 'active', action: 'block', expected: [] },
    { name: 'block from running', from: 'running', action: 'block', expected: [] },
    { name: 'complete from active', from: 'active', action: 'complete', expected: [] },
    { name: 'complete from running', from: 'running', action: 'complete', expected: [] },
    { name: 'cancel from blocked', from: 'blocked', action: 'cancel', expected: ['cancelled'] },
    { name: 'executor_finish done', from: 'running', action: 'executor_finish', payload: { finalStatus: 'done' }, expected: [] },
    { name: 'executor_finish failed', from: 'running', action: 'executor_finish', payload: { finalStatus: 'failed' }, expected: [] },
    { name: 'executor_partial_finish from running', from: 'running', action: 'executor_partial_finish', expected: [] },
    { name: 'reviewer_repair_resume from active', from: 'active', action: 'reviewer_repair_resume', expected: ['running'] },
    { name: 'reviewer_repair_resume from running (no-op)', from: 'running', action: 'reviewer_repair_resume', expected: [] },
    { name: 'crash_recovery_drop_to_backlog from running', from: 'running', action: 'crash_recovery_drop_to_backlog', expected: ['backlog'] },
    { name: 'crash_recovery_drop_to_backlog from active', from: 'active', action: 'crash_recovery_drop_to_backlog', expected: ['backlog'] },
    { name: 'planner_set_status failed→backlog', from: 'failed', action: 'planner_set_status', payload: { requestedStatus: 'backlog' }, expected: ['backlog'] },
    { name: 'planner_set_status same status (no-op)', from: 'backlog', action: 'planner_set_status', payload: { requestedStatus: 'backlog' }, expected: [] },
  ];

  it.each(cases)('emits expected setStatus sequence: $name', async ({ from, action, payload, expected }) => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      const { cardStore, machine, setStatusCalls } = build(projectRoot);
      const cardId = seed(cardStore, from);
      const ok = await machine.transitionCard(cardId, action, payload);
      expect(ok).toBe(true);
      expect(setStatusCalls.map((c) => c.status)).toEqual(expected);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('rejects unsupported source state for fail and logs state_machine_invalid_source_state', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      const { cardStore, machine, setStatusCalls, errorLogger } = build(projectRoot);
      const cardId = seed(cardStore, 'done');
      const ok = await machine.transitionCard(cardId, 'fail');
      expect(ok).toBe(false);
      expect(setStatusCalls.length).toBe(0);
      const errs = errorLogger.getErrors().filter((e) => e.code === 'state_machine_invalid_source_state');
      expect(errs.length).toBe(1);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('rejects planner_set_status when target is not a valid transition and logs state_machine_planner_status_rejected', async () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      const { cardStore, machine, setStatusCalls, errorLogger } = build(projectRoot);
      const cardId = seed(cardStore, 'done');
      const ok = await machine.transitionCard(cardId, 'planner_set_status', { requestedStatus: 'running' });
      expect(ok).toBe(false);
      expect(setStatusCalls.length).toBe(0);
      const errs = errorLogger.getErrors().filter((e) => e.code === 'state_machine_planner_status_rejected');
      expect(errs.length).toBe(1);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});
